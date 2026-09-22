// Audio module: quản lý các track nhạc/hiệu ứng của game (background, die, end, jump, quiz, glory).
// Nhạc dài/loop (background, end, glory) dùng HTMLAudioElement như bình thường. Hiệu ứng
// ngắn cần phản hồi tức thời (click, jump, die, correctAnswer, wrongAnswer) dùng Web Audio
// API (xem phần playSfx() bên dưới để hiểu lý do) thay vì thẻ <audio>.
// Quy tắc trigger (theo yêu cầu):
//  - background: bật ngay khi bắt đầu trận, loop liên tục.
//  - die: phát mỗi khi CHÍNH MÌNH chết, đồng thời kéo volume của background xuống 0
//    (không dừng hẳn, chỉ tắt tiếng) cho đến khi hồi sinh thì mới trả lại volume gốc.
//  - end: khi trận kết thúc, dừng hẳn background và phát end thay thế.
//  - jump: phát mỗi khi CHÍNH MÌNH nhảy (không phát cho hành động của người chơi khác,
//    vì flap() chỉ được gọi từ input cục bộ của chính người đang chơi trên máy đó).
//  - correctAnswer/wrongAnswer: phát khi CHÍNH MÌNH trả lời câu hỏi quiz đúng/sai.
//  - glory (easter egg logo MU): crossfade với background theo khoảng cách tới logo.
//    game.js gọi updateGloryProximity(0..1) mỗi frame khi đang gần vùng ảnh hưởng của logo
//    (0 = ở biên vùng/ngoài vùng, 1 = đúng tại logo). Khi proximity > 0, module này TỰ
//    KIỂM SOÁT volume của cả bgMusic và gloryMusic theo tỉ lệ nghịch (crossfade thật, không
//    phải fade riêng lẻ) - vì vậy trong lúc này duckFadeTimer (dùng cho die/restore) không
//    được đụng vào bgMusic.volume để tránh 2 nguồn ghi đè lẫn nhau. Quiz KHÔNG tắt/pause
//    glory (nhạc tiếp tục phát xuyên qua popup quiz); chỉ khi chết, game.js gọi stopGlory()
//    để dừng hẳn và trả quyền kiểm soát bgMusic.volume lại cho duck.

const Audio_ = (() => {
  const BACKGROUND_VOLUME = 0.5; // volume "bình thường" của background khi không bị duck
  const DUCK_FADE_MS = 150; // thời gian fade nhanh khi tắt/mở lại tiếng background, tránh giật âm thanh

  // Trình duyệt chặn autoplay có âm thanh nếu chưa có tương tác người dùng nào.
  // .play() trả về Promise, ta nuốt lỗi im lặng để không log rác console nếu bị chặn
  // (trong luồng game thật, lệnh gọi đầu tiên luôn xảy ra sau khi người dùng đã bấm
  // nút "Bắt đầu"/nhập nickname, nên hầu như không bao giờ bị chặn thực tế).
  function safePlay(audioEl) {
    const p = audioEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  // ----- Web Audio API cho các hiệu ứng ngắn (click, jump, correctAnswer, wrongAnswer, die) -----
  // TẠI SAO không dùng thẻ <audio> (HTMLAudioElement) như trước cho các âm này: sau khi
  // sửa bằng audio pool (preload sẵn nhiều instance) vẫn còn hiện tượng "để tab không thao
  // tác 1 lúc rồi bấm thì tiếng nhỏ/cụt, bấm liên tiếp ngay sau đó thì to bình thường".
  // Đây KHÔNG phải do thiếu preload - đây là chính sách tiết kiệm năng lượng/CPU của trình
  // duyệt: khi tab không tương tác, audio pipeline ở tầng hệ thống bị điều tiết/treo một
  // phần, khiến lệnh .play() đầu tiên phát ra trước khi phần cứng âm thanh "tỉnh" hoàn
  // toàn - bị cắt mất phần đầu âm lượng. Đây là vấn đề ở tầng driver/OS, thẻ <audio>
  // thường không có cách nào chủ động can thiệp.
  // Web Audio API (AudioContext) giải quyết đúng gốc: âm thanh được decode sẵn thành dữ
  // liệu PCM thô (AudioBuffer) nằm trong RAM ngay từ đầu, và audioContext.resume() cho
  // phép CHỦ ĐỘNG đánh thức pipeline âm thanh trước khi phát, thay vì để trình duyệt tự
  // xử lý ngầm không đáng tin cậy như <audio>.play().
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioContextClass ? new AudioContextClass() : null;
  const sfxBuffers = {}; // { name: AudioBuffer } - đã decode sẵn, phát nhiều lần không cần tải lại

  async function loadSfx(name, url) {
    if (!audioCtx) return; // trình duyệt cổ không hỗ trợ Web Audio API -> bỏ qua, không lỗi
    try {
      const res = await fetch(url);
      const arrayBuffer = await res.arrayBuffer();
      sfxBuffers[name] = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (err) {
      console.error(`Không tải/decode được âm thanh "${name}":`, err);
    }
  }

  // Phát 1 buffer đã decode sẵn qua Web Audio API. Mỗi lần phát tạo 1 AudioBufferSourceNode
  // mới (rất rẻ, không giống việc tạo hẳn 1 <audio> element) - cho phép chồng âm tự nhiên
  // khi bấm/nhảy liên tiếp mà không cần pool thủ công như cách cũ.
  function playSfx(name, volume) {
    if (!audioCtx || !sfxBuffers[name]) return;
    // Chủ động đánh thức AudioContext nếu đang bị trình duyệt suspend (đây là bước quan
    // trọng nhất để sửa triệt để bug "lần đầu sau khi im lặng lâu nghe bé/cụt").
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const source = audioCtx.createBufferSource();
    source.buffer = sfxBuffers[name];
    const gain = audioCtx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.start(0);
  }

  loadSfx("click", "assets/click_sound.mp3");
  loadSfx("jump", "assets/jump.mp3");
  loadSfx("correctAnswer", "assets/correct_answer.mp3");
  loadSfx("wrongAnswer", "assets/wrong_answer.mp3");
  loadSfx("die", "assets/die.mp3");
  loadSfx("countdown", encodeURI("assets/3 2 1 fight.mp3")); // tên file có khoảng trắng -> encode rõ ràng, không phụ thuộc auto-encode ngầm định của fetch()

  // Một số trình duyệt (đặc biệt Safari/iOS) tạo AudioContext ở trạng thái "suspended" cho
  // tới khi có tương tác người dùng đầu tiên (click/tap/keydown bất kỳ) - lắng nghe 1 lần
  // duy nhất để resume ngay khi có thể, thay vì đợi tới lần phát âm thanh đầu tiên.
  function resumeAudioContextOnce() {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    document.removeEventListener("pointerdown", resumeAudioContextOnce);
    document.removeEventListener("keydown", resumeAudioContextOnce);
  }
  document.addEventListener("pointerdown", resumeAudioContextOnce);
  document.addEventListener("keydown", resumeAudioContextOnce);

  const bgMusic = new Audio("assets/background.mp3");
  bgMusic.loop = true;
  bgMusic.volume = BACKGROUND_VOLUME;

  const endMusic = new Audio("assets/end.mp3");

  const gloryMusic = new Audio("assets/glory_glory_easter_egg.mp3");
  gloryMusic.loop = false; // file dài ~18s, không loop - nếu đứng quá lâu trong vùng thì tự hết rồi im, chấp nhận được

  let duckFadeTimer = null;
  let gloryActive = false; // đang trong vùng ảnh hưởng của 1 logo MU nào đó (proximity > 0)

  function fadeVolume(audioEl, targetVolume, durationMs) {
    clearInterval(duckFadeTimer);
    const steps = 10;
    const stepMs = durationMs / steps;
    const startVolume = audioEl.volume;
    const delta = (targetVolume - startVolume) / steps;
    let step = 0;

    duckFadeTimer = setInterval(() => {
      step++;
      audioEl.volume = Math.max(0, Math.min(1, startVolume + delta * step));
      if (step >= steps) {
        audioEl.volume = targetVolume;
        clearInterval(duckFadeTimer);
      }
    }, stepMs);
  }

  function playBackground() {
    bgMusic.volume = BACKGROUND_VOLUME;
    bgMusic.currentTime = 0;
    safePlay(bgMusic);
  }

  function stopBackground() {
    bgMusic.pause();
    clearInterval(duckFadeTimer);
  }

  // Khi chết: phát die, đồng thời kéo volume background về 0 (không dừng hẳn, để khi
  // hồi sinh chỉ cần trả lại volume là nhạc tiếp tục đúng nhịp đang phát, không bị giật).
  function playDie() {
    playSfx("die", 1);
    fadeVolume(bgMusic, 0, DUCK_FADE_MS);
  }

  // Khi hồi sinh: trả volume background về mức bình thường.
  function restoreBackground() {
    fadeVolume(bgMusic, BACKGROUND_VOLUME, DUCK_FADE_MS);
  }

  // Easter egg logo MU: game.js gọi hàm này mỗi frame với proximity trong [0, 1] khi
  // chim đang ở trong vùng ảnh hưởng của 1 logo (0 = vừa vào biên vùng, 1 = đúng tại logo).
  // Đây là crossfade tuyến tính thật: gloryVolume tăng đúng bằng lượng bgVolume giảm.
  // Quiz KHÔNG gọi hàm dừng nào - proximity vẫn tiếp tục cập nhật xuyên suốt popup quiz
  // (vì worldOffset đứng yên trong lúc quiz, proximity giữ nguyên giá trị, gloryMusic tiếp
  // tục phát không gián đoạn).
  function updateGloryProximity(proximity) {
    const clamped = Math.max(0, Math.min(1, proximity));

    if (clamped <= 0) {
      if (gloryActive) stopGlory();
      return;
    }

    gloryActive = true;
    if (gloryMusic.paused) {
      safePlay(gloryMusic);
    }

    // Crossfade: proximity càng cao (càng gần logo) thì glory càng to, background càng nhỏ.
    gloryMusic.volume = clamped;
    bgMusic.volume = BACKGROUND_VOLUME * (1 - clamped);
  }

  // Dừng HẲN glory (ra khỏi vùng ảnh hưởng thật sự, hoặc chết) - reset currentTime về 0
  // để lần sau vào vùng sẽ phát lại từ đầu bài, đúng như 1 lượt "duyệt qua logo" mới.
  function stopGlory() {
    gloryActive = false;
    gloryMusic.pause();
    gloryMusic.currentTime = 0;
    bgMusic.volume = BACKGROUND_VOLUME;
  }

  // Khi trận kết thúc: tắt hẳn background VÀ glory glory (nếu đang phát dở, ví dụ hết giờ
  // ngay lúc đang đứng gần logo MU), rồi phát end thay thế.
  function playEnd() {
    stopBackground();
    stopGlory();
    endMusic.currentTime = 0;
    safePlay(endMusic);
  }

  // Khi nhảy: người chơi có thể bấm Space rất nhanh liên tiếp - Web Audio API cho phép
  // chồng nhiều AudioBufferSourceNode tự nhiên mà không cần pool thủ công.
  function playJump() {
    playSfx("jump", 0.6); // hơi nhỏ hơn mặc định vì phát rất dồn dập, dễ chói tai nếu để to
  }

  function playCorrectAnswer() {
    playSfx("correctAnswer", 1);
  }

  function playWrongAnswer() {
    playSfx("wrongAnswer", 1);
  }

  // Khi bấm bất kỳ nút nào trong UI (lobby, quiz...).
  function playClick() {
    playSfx("click", 0.5);
  }

  // Phát đúng 1 lần khi bắt đầu đếm ngược "3-2-1-Fight" trước mỗi trận đấu.
  function playCountdown() {
    playSfx("countdown", 1);
  }

  function stopAll() {
    stopBackground();
    endMusic.pause();
    stopGlory();
  }

  return {
    playBackground,
    stopBackground,
    playDie,
    restoreBackground,
    playEnd,
    playJump,
    playCorrectAnswer,
    playWrongAnswer,
    playClick,
    playCountdown,
    updateGloryProximity,
    stopGlory,
    stopAll,
  };
})();
