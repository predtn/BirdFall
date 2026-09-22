// Audio module: quản lý nhạc/hiệu ứng của game (background, die, end, jump, quiz, glory).
// Nhạc dài/loop (background, end, glory) dùng HTMLAudioElement. Hiệu ứng ngắn (click, jump,
// die, correctAnswer, wrongAnswer) dùng Web Audio API (xem playSfx() để hiểu lý do).
// Lưu ý: khi proximity glory > 0, module tự kiểm soát volume bgMusic/gloryMusic theo tỉ lệ
// nghịch (crossfade) - duckFadeTimer (die/restore) không được đụng vào bgMusic.volume lúc
// này để tránh 2 nguồn ghi đè lẫn nhau. Quiz KHÔNG tắt glory; chỉ chết mới gọi stopGlory().

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
  // Lý do không dùng <audio>: sau 1 lúc tab không tương tác, trình duyệt điều tiết/treo một
  // phần audio pipeline để tiết kiệm CPU, khiến .play() đầu tiên bị cắt mất phần đầu âm
  // lượng - vấn đề ở tầng driver/OS mà <audio> không can thiệp được. AudioContext.resume()
  // cho phép chủ động đánh thức pipeline trước khi phát, giải quyết đúng gốc vấn đề.
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioContextClass ? new AudioContextClass() : null;
  const sfxBuffers = {}; // { name: AudioBuffer } - đã decode sẵn, phát nhiều lần không cần tải lại

  async function loadSfx(name, url) {
    if (!audioCtx) return;
    try {
      const res = await fetch(url);
      const arrayBuffer = await res.arrayBuffer();
      sfxBuffers[name] = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (err) {
      console.error(`Không tải/decode được âm thanh "${name}":`, err);
    }
  }

  // Mỗi lần phát tạo 1 AudioBufferSourceNode mới (rẻ) - cho phép chồng âm tự nhiên khi
  // bấm/nhảy liên tiếp mà không cần pool thủ công.
  function playSfx(name, volume) {
    if (!audioCtx || !sfxBuffers[name]) return;
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
  loadSfx("countdown", encodeURI("assets/3 2 1 fight.mp3")); // tên file có khoảng trắng -> encode rõ ràng

  // Safari/iOS tạo AudioContext ở trạng thái "suspended" tới khi có tương tác đầu tiên.
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
  gloryMusic.loop = false; // ~18s, nếu đứng quá lâu trong vùng thì tự hết rồi im, chấp nhận được

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

  // Chết: phát die, kéo volume background về 0 (không dừng hẳn, để hồi sinh chỉ cần trả
  // volume là nhạc tiếp tục đúng nhịp, không giật).
  function playDie() {
    playSfx("die", 1);
    fadeVolume(bgMusic, 0, DUCK_FADE_MS);
  }

  function restoreBackground() {
    fadeVolume(bgMusic, BACKGROUND_VOLUME, DUCK_FADE_MS);
  }

  // Easter egg logo MU: game.js gọi mỗi frame với proximity [0,1] (0 = biên vùng, 1 = tại
  // logo) - crossfade tuyến tính thật giữa bgMusic và gloryMusic.
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

    gloryMusic.volume = clamped;
    bgMusic.volume = BACKGROUND_VOLUME * (1 - clamped);
  }

  // Dừng hẳn glory (ra khỏi vùng, hoặc chết) - reset currentTime để lần sau phát lại từ đầu.
  function stopGlory() {
    gloryActive = false;
    gloryMusic.pause();
    gloryMusic.currentTime = 0;
    bgMusic.volume = BACKGROUND_VOLUME;
  }

  // Trận kết thúc: tắt hẳn background và glory (nếu đang phát dở), phát end thay thế.
  function playEnd() {
    stopBackground();
    stopGlory();
    endMusic.currentTime = 0;
    safePlay(endMusic);
  }

  function playJump() {
    playSfx("jump", 0.6); // nhỏ hơn mặc định vì phát dồn dập, dễ chói tai nếu để to
  }

  function playCorrectAnswer() {
    playSfx("correctAnswer", 1);
  }

  function playWrongAnswer() {
    playSfx("wrongAnswer", 1);
  }

  function playClick() {
    playSfx("click", 0.5);
  }

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
