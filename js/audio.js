// Audio module: quản lý các track nhạc/hiệu ứng của game (background, die, end, jump, quiz, glory).
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

  const bgMusic = new Audio("assets/background.mp3");
  bgMusic.loop = true;
  bgMusic.volume = BACKGROUND_VOLUME;

  const dieMusic = new Audio("assets/die.mp3");
  const endMusic = new Audio("assets/end.mp3");
  const jumpMusic = new Audio("assets/jump.mp3");
  jumpMusic.volume = 0.6; // hơi nhỏ hơn mặc định vì tiếng nhảy phát rất dồn dập, dễ chói tai nếu để to

  const correctAnswerMusic = new Audio("assets/correct_answer.mp3");
  const wrongAnswerMusic = new Audio("assets/wrong_answer.mp3");

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

  // Trình duyệt chặn autoplay có âm thanh nếu chưa có tương tác người dùng nào.
  // .play() trả về Promise, ta nuốt lỗi im lặng để không log rác console nếu bị chặn
  // (trong luồng game thật, lệnh gọi đầu tiên luôn xảy ra sau khi người dùng đã bấm
  // nút "Bắt đầu"/nhập nickname, nên hầu như không bao giờ bị chặn thực tế).
  function safePlay(audioEl) {
    const p = audioEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
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
    dieMusic.currentTime = 0;
    safePlay(dieMusic);
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

  // Khi nhảy: người chơi có thể bấm Space rất nhanh liên tiếp, nếu dùng chung 1 <audio>
  // và reset currentTime mỗi lần thì tiếng sẽ bị cắt cụt/giật. Dùng cloneNode() để mỗi
  // lần nhảy là 1 instance audio riêng, được phép chồng lên nhau, nghe tự nhiên hơn.
  function playJump() {
    const instance = jumpMusic.cloneNode();
    instance.volume = jumpMusic.volume;
    safePlay(instance);
  }

  // Khi trả lời quiz đúng/sai: mỗi lượt chỉ phát 1 lần, không cần cloneNode như jump
  // (không bị bấm dồn dập liên tiếp), reset currentTime để phát lại từ đầu nếu lỡ
  // trả lời sai nhiều câu liên tiếp trong cùng 1 popup quiz.
  function playCorrectAnswer() {
    correctAnswerMusic.currentTime = 0;
    safePlay(correctAnswerMusic);
  }

  function playWrongAnswer() {
    wrongAnswerMusic.currentTime = 0;
    safePlay(wrongAnswerMusic);
  }

  function stopAll() {
    stopBackground();
    dieMusic.pause();
    endMusic.pause();
    correctAnswerMusic.pause();
    wrongAnswerMusic.pause();
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
    updateGloryProximity,
    stopGlory,
    stopAll,
  };
})();
