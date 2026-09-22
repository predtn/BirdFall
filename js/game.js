// BirdFall - Flappy Bird kèm quiz mỗi 3 cột vượt qua, chơi multiplayer theo phòng.
// Mọi người trong phòng chạy cùng 1 seed để cột giống hệt nhau, tự bay độc lập
// cục bộ, chỉ đồng bộ vị trí chim + điểm số qua Network để thấy nhau bay.

const Game = (() => {
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");

  const W = canvas.width;
  const H = canvas.height;

  const scoreHud = document.getElementById("score-hud");
  const timerHud = document.getElementById("timer-hud");

  // ----- Tham số gameplay -----
  // Bộ thông số "core physics" dưới đây được cân theo giá trị per-frame @60fps
  // mà cộng đồng đã reverse-engineer từ Flappy Bird gốc (canvas gốc 288x512),
  // sau đó quy đổi theo tỉ lệ kích thước canvas hiện tại (480x640, scale ~1.667x)
  // rồi chuyển sang px/giây để nhân với deltaTime thực tế mỗi khung hình —
  // nhờ vậy tốc độ game giống nhau dù màn hình chạy 60Hz, 120Hz hay 144Hz.
  const REFERENCE_FPS = 60;
  const SCALE = W / 288; // tỉ lệ so với canvas gốc 288px chiều rộng

  const GRAVITY = 0.25 * SCALE * REFERENCE_FPS * REFERENCE_FPS; // px/s^2 (gốc: 0.25 px/frame^2 @288px)
  const FLAP_VELOCITY = -4.6 * SCALE * REFERENCE_FPS; // px/s (gốc: -4.6 px/frame)
  const MAX_FALL_SPEED = 10 * SCALE * REFERENCE_FPS; // px/s (gốc: 10 px/frame)
  const PIPE_GAP = Math.round(100 * SCALE); // px (gốc: 100px @288px rộng)
  const PIPE_WIDTH = 62;
  const PIPE_SPEED = 3 * 0.85 * 0.85 * SCALE * REFERENCE_FPS; // px/s (gốc: 3 px/frame, giảm tiết tấu ~28%)
  const PIPE_SPACING = Math.round(200 * SCALE); // px (gốc: 200px @288px rộng)
  const QUIZ_EVERY_N_PIPES = 3;
  const MAX_DT = 1 / 30; // tránh giật lag khi tab bị treo/đổi tab
  const GROUND_HEIGHT = 56; // dải đất ở đáy màn hình, chim chạm vào đây mới tính là rơi
  const PIPE_PATTERN_LENGTH = 3; // 1 pattern áp dụng cho mỗi 3 cột, khớp với nhịp quiz
  const PATTERN_CYCLE = ["easy", "normal", "hard", "zigzag"]; // lặp lại theo vòng, cứ ~4 cụm có 1 cụm "cao trào"
  const NETWORK_SEND_INTERVAL = 1 / 20; // gửi vị trí chim của mình ~20 lần/giây (tăng từ 15 để buffered interpolation có nhiều điểm dữ liệu hơn, mượt hơn)

  // ----- Hiệu ứng chết kiểu Mario -----
  // Khi chết: chim bật ngược lên 1 phát (giống nhân vật Mario chết), rồi rơi thẳng
  // xuống với gia tốc mạnh hơn bình thường trong lúc xoay tròn liên tục, biến mất khỏi
  // đáy màn hình trước khi hiện overlay đếm ngược hồi sinh. Thế giới (cột/người khác/
  // camera) vẫn tiếp tục chạy bình thường trong lúc này, chỉ riêng chim của mình rơi.
  const DEATH_BOUNCE_VELOCITY = -6 * SCALE * REFERENCE_FPS; // px/s, lực bật lên tức thời lúc vừa chết
  const DEATH_GRAVITY = GRAVITY * 1.6; // rơi nhanh hơn bình thường một chút cho kịch tính
  const DEATH_SPIN_SPEED = 10; // rad/giây, tốc độ xoay tròn liên tục trong lúc rơi
  const DEATH_ANIM_MAX_DURATION = 1.2; // giây, ngưỡng an toàn tối đa trước khi ép chuyển sang màn hình hồi sinh dù chưa rơi khỏi màn hình

  let bird;
  let pipes; // map CỐ ĐỊNH, sinh 1 lần khi bắt đầu trận, mỗi cột có worldX tuyệt đối không đổi
  let score; // điểm của lượt chơi hiện tại (reset về 0 mỗi khi chết trong trận)
  let bestScore; // điểm cao nhất đạt được trong toàn trận, đây là điểm gửi lên server chấm
  let pipesSincePipeQuiz;
  let frame;
  let worldOffset; // quãng đường (px) mà CHÍNH MÌNH đã bay được kể từ đầu lượt chơi hiện tại -> dùng làm camera
  let state; // "idle" | "playing" | "quiz" | "dying" | "dead"
  let deathAnimElapsed; // thời gian (giây) đã trôi qua trong animation chết kiểu Mario, dùng để tính spin/rơi
  let rand; // seeded RNG dùng chung, đồng bộ giữa mọi người chơi trong phòng (chỉ dùng lúc sinh map 1 lần)
  let matchEndAt; // timestamp (ms) khi trận kết thúc
  let networkSendTimer;
  let otherPlayers; // Map<socketId, {nickname, buffer: [{t, worldX, y, vy}], renderWorldX, renderY, renderVy, alive}>
  let lastTime = null;
  let rafId = null;
  let mapTotalLength = 0; // tổng chiều dài map (worldX của cột cuối cùng), dùng để tính % tiến độ cho thanh đua
  const VIEW_MARGIN = 80; // chỉ vẽ chim/cột khi nằm trong [-margin, W+margin] so với camera, để không lãng phí lúc quá xa

  // ----- Thanh đua (race track) -----
  const RACE_BAR_HEIGHT = 22;
  const RACE_BAR_MARGIN_X = 12; // lề trái/phải của dải đua, icon không bao giờ vẽ sát mép ngoài cùng

  // ----- Chỉ báo người chơi ngoài tầm nhìn (off-screen indicator) -----
  // Khi ai đó ở quá xa để hiện chim thật trên màn hình, thay vì ẩn hẳn, dán 1 icon nhỏ
  // sát mép trái/phải canvas theo đúng độ cao (y) thật của họ, thu nhỏ dần theo khoảng cách.
  const OFFSCREEN_ICON_MARGIN = 22; // khoảng cách từ icon đến mép canvas
  const OFFSCREEN_ICON_MAX_SCALE = 1; // scale khi vừa ra khỏi tầm nhìn (kích thước gần bằng chim thật)
  const OFFSCREEN_ICON_MIN_SCALE = 0.5; // scale tối thiểu khi ở rất xa, không nhỏ hơn nữa để vẫn nhìn rõ được
  const OFFSCREEN_ICON_FALLOFF_DISTANCE = 1200; // khoảng cách (px) để scale giảm từ MAX xuống MIN

  // ----- Easter egg logo MU + nhạc "glory glory" crossfade -----
  // Logo xuất hiện tại cột thứ 40%/80% trong số cột mà 1 người bay LIÊN TỤC KHÔNG CHẾT
  // thực sự vượt qua được trong đúng thời gian trận (không phải % của map dự phòng dài
  // hơn nhiều dùng để tránh hết cột khi có người chết/hồi sinh nhiều lần - map dự phòng
  // đó dài gấp 1.5 lần, nếu đặt logo theo % của nó thì logo sẽ nằm quá xa, gần như không
  // ai tới được trong 1 trận thật). estimatedPipeCount tính trong startMultiplayer().
  // File nhạc glory dài ~18s (không loop), GLORY_RANGE tính sao cho tổng thời gian đi qua
  // CẢ vùng (fade in + fade out) vừa khít, dư margin an toàn: 2*(1600/PIPE_SPEED)≈14.76s.
  const GLORY_LOGO_PERCENTAGES = [0.2, 0.6]; // % số cột thực tế bay được trong trận
  const GLORY_RANGE = 1600; // px mỗi bên logo - trong khoảng này thì crossfade dần
  const GLORY_LOGO_SIZE = 64; // px, kích thước hiển thị logo trên canvas
  let gloryLogoWorldXs = []; // worldX tuyệt đối của từng logo, tính 1 lần khi bắt đầu trận
  const gloryLogoImg = new Image();
  gloryLogoImg.src = "assets/MU.png";

  // ----- Sinh map cố định 1 lần khi bắt đầu trận -----
  // Map dài đủ để phủ hết thời gian trận đấu + rơi lại từ đầu nhiều lần (người chơi
  // giỏi/tệ khác nhau đều dùng chung 1 map cố định này để so sánh vị trí công bằng).
  function generateFixedMap(durationSec) {
    const margin = 60;
    let lastGapCenter = H / 2;
    const result = [];

    // Ước lượng hào phóng: đủ cột để bay hết toàn bộ thời gian trận + thêm 50% dự phòng
    // (vì người chơi có thể chết/hồi sinh nhiều lần, nhưng world vẫn chỉ dài bằng 1 lượt bay hết giờ)
    const totalWorldLength = PIPE_SPEED * durationSec * 1.5;
    const pipeCount = Math.ceil(totalWorldLength / PIPE_SPACING) + 5;

    for (let pipeIndex = 0; pipeIndex < pipeCount; pipeIndex++) {
      const worldX = 400 + pipeIndex * PIPE_SPACING; // 400px đầu tiên là khoảng trống an toàn để khởi động
      const cycleIndex = Math.floor(pipeIndex / PIPE_PATTERN_LENGTH) % PATTERN_CYCLE.length;
      const pattern = PATTERN_CYCLE[cycleIndex];
      const posInPattern = pipeIndex % PIPE_PATTERN_LENGTH;

      // Độ khó nền tăng dần theo vị trí cột trong map (thay cho theo điểm số trước đây,
      // vì giờ map cố định chung cho mọi người, không thể phụ thuộc điểm riêng từng người)
      const difficultyShrink = Math.min(25, Math.floor(pipeIndex / 6) * 3);
      let gap = PIPE_GAP - difficultyShrink;
      let gapCenter;

      const minCenter = margin + gap / 2;
      const maxCenter = H - margin - gap / 2;

      switch (pattern) {
        case "easy":
          gap = PIPE_GAP + 20;
          gapCenter = H / 2 + (rand() - 0.5) * 40;
          break;

        case "hard":
          gap = Math.max(110, gap - 20);
          gapCenter =
            rand() < 0.5
              ? margin + gap / 2 + rand() * 30
              : H - margin - gap / 2 - rand() * 30;
          break;

        case "zigzag":
          gap = Math.max(120, gap - 10);
          gapCenter =
            posInPattern % 2 === 0
              ? minCenter + (maxCenter - minCenter) * 0.2
              : minCenter + (maxCenter - minCenter) * 0.8;
          break;

        case "normal":
        default: {
          const maxJump = 140;
          const low = Math.max(minCenter, lastGapCenter - maxJump);
          const high = Math.min(maxCenter, lastGapCenter + maxJump);
          gapCenter = low + rand() * Math.max(1, high - low);
          break;
        }
      }

      gapCenter = Math.max(minCenter, Math.min(maxCenter, gapCenter));
      lastGapCenter = gapCenter;

      result.push({ worldX, gap, gapCenter, passed: false });
    }

    return result;
  }

  function resetRun() {
    bird = { y: H / 2, vy: 0, radius: 14 };
    score = 0;
    pipesSincePipeQuiz = 0;
    worldOffset = 0;
    state = "playing";
    scoreHud.textContent = String(bestScore);
    pipes.forEach((p) => (p.passed = false));
  }

  function flap() {
    if (state === "playing") {
      bird.vy = FLAP_VELOCITY;
      Audio_.playJump(); // chỉ trigger cho input cục bộ của chính mình, không liên quan người chơi khác
    }
  }

  // Tính proximity (0..1) tới logo MU gần nhất trong tầm ảnh hưởng, dựa trên vị trí THẬT
  // của CHÍNH MÌNH trên map (birdWorldX) - hoàn toàn không liên quan tới người chơi khác,
  // nên chỉ mình nghe crossfade glory glory khi chính mình tới gần logo.
  function updateGloryProximity(birdWorldX) {
    let bestProximity = 0;
    for (const logoX of gloryLogoWorldXs) {
      const distance = Math.abs(birdWorldX - logoX);
      if (distance >= GLORY_RANGE) continue;
      const proximity = 1 - distance / GLORY_RANGE; // 0 ở biên vùng, 1 đúng tại logo
      if (proximity > bestProximity) bestProximity = proximity;
    }
    Audio_.updateGloryProximity(bestProximity);
  }

  function update(dt) {
    updateTimerHud();
    updateOtherPlayersInterpolation();

    if (state === "dying") {
      updateDeathAnimation(dt);
      return;
    }

    if (state !== "playing") return;
    frame++;

    bird.vy += GRAVITY * dt;
    if (bird.vy > MAX_FALL_SPEED) bird.vy = MAX_FALL_SPEED;
    bird.y += bird.vy * dt;

    worldOffset += PIPE_SPEED * dt;
    const birdWorldX = worldOffset + 90; // vị trí thật của chim trên map cố định (90 = x hiển thị trên màn hình)

    updateGloryProximity(birdWorldX);

    for (const pipe of pipes) {
      if (!pipe.passed && pipe.worldX + PIPE_WIDTH < birdWorldX - bird.radius) {
        pipe.passed = true;
        score++;
        if (score > bestScore) {
          bestScore = score;
          scoreHud.textContent = String(bestScore);
          Network.sendScore(bestScore);
        }
        pipesSincePipeQuiz++;

        if (pipesSincePipeQuiz >= QUIZ_EVERY_N_PIPES) {
          pipesSincePipeQuiz = 0;
          // Quiz hiện lên KHÔNG tắt/pause glory glory - nhạc (nếu đang phát) tiếp tục
          // chạy xuyên suốt popup quiz, vì worldOffset đứng yên trong lúc quiz nên
          // proximity cũng giữ nguyên, không cần can thiệp gì thêm ở đây.
          triggerQuiz();
          return;
        }
      }
    }

    if (bird.y + bird.radius > H - GROUND_HEIGHT || bird.y - bird.radius < 0) {
      Audio_.stopGlory(); // yêu cầu: chết thì tắt luôn glory glory
      return handleDeath();
    }

    for (const pipe of pipes) {
      const withinX = birdWorldX + bird.radius > pipe.worldX && birdWorldX - bird.radius < pipe.worldX + PIPE_WIDTH;
      if (withinX) {
        const topPipeBottom = pipe.gapCenter - pipe.gap / 2;
        const bottomPipeTop = pipe.gapCenter + pipe.gap / 2;
        const hitsTop = bird.y - bird.radius < topPipeBottom;
        const hitsBottom = bird.y + bird.radius > bottomPipeTop;
        if (hitsTop || hitsBottom) {
          Audio_.stopGlory(); // yêu cầu: chết thì tắt luôn glory glory
          return handleDeath();
        }
      }
    }
  }

  const RESPAWN_DELAY_SEC = 3;
  const deathScreen = document.getElementById("death-screen");
  const deathCountdownNumber = document.getElementById("death-countdown-number");
  let respawnTimer = null;

  function handleDeath() {
    // Bắt đầu hiệu ứng chết kiểu Mario: chim bật ngược lên rồi rơi xoay tròn ra khỏi
    // màn hình. Thế giới (cột/người khác/camera) không tự trôi thêm trong lúc này
    // (worldOffset đứng yên tại đúng vị trí vừa chết), nhưng người khác vẫn tự
    // interpolate/di chuyển theo world offset thật của họ nên vẫn thấy họ "trôi qua".
    state = "dying";
    deathAnimElapsed = 0;
    bird.vy = DEATH_BOUNCE_VELOCITY;
    Network.sendPlayerState({ worldOffset, y: bird.y, vy: bird.vy, angle: 0, alive: false });
    Audio_.playDie(); // phát nhạc die + tự động kéo volume background về 0
  }

  function updateDeathAnimation(dt) {
    deathAnimElapsed += dt;

    bird.vy += DEATH_GRAVITY * dt;
    bird.y += bird.vy * dt;

    const fellOffScreen = bird.y - bird.radius > H; // rơi hẳn khỏi mép dưới canvas (không chỉ chạm đất)
    const timedOut = deathAnimElapsed >= DEATH_ANIM_MAX_DURATION;
    if (fellOffScreen || timedOut) {
      showDeathOverlay();
    }
  }

  function showDeathOverlay() {
    // Luật: hết giờ mới kết thúc trận, ai điểm cao nhất thắng -> chết thì hồi sinh
    // lại từ vạch xuất phát (worldOffset = 0) sau ít giây, không phải chờ ai khác.
    // bestScore (điểm gửi server) không bị reset dù bay lại từ đầu map.
    state = "dead";

    let remaining = RESPAWN_DELAY_SEC;
    deathCountdownNumber.textContent = remaining;
    deathScreen.classList.remove("hidden");

    clearTimeout(respawnTimer);
    const tick = () => {
      remaining--;
      if (remaining > 0) {
        deathCountdownNumber.textContent = remaining;
        deathCountdownNumber.style.animation = "none";
        void deathCountdownNumber.offsetWidth; // ép reflow để animation chạy lại mỗi lần đổi số
        deathCountdownNumber.style.animation = "";
        respawnTimer = setTimeout(tick, 1000);
      } else {
        deathScreen.classList.add("hidden");
        Audio_.restoreBackground(); // hồi sinh xong -> trả volume background về bình thường
        resetRun();
      }
    };
    respawnTimer = setTimeout(tick, 1000);
  }

  function updateTimerHud() {
    if (!matchEndAt) return;
    const remainingMs = matchEndAt - Date.now();
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
    timerHud.textContent = `${remainingSec}s`;
    timerHud.classList.toggle("time-low", remainingSec <= 10);
  }

  function triggerQuiz() {
    state = "quiz";
    Quiz.show(() => {
      state = "playing";
      bird.vy = 0;
    });
  }

  // ----- Vẽ -----
  function draw() {
    ctx.clearRect(0, 0, W, H);

    drawSky();
    drawMountains();
    drawClouds();
    drawPipes();
    drawGloryLogos();
    drawGround();
    drawOtherBirds();
    const dyingAngle = state === "dying" ? deathAnimElapsed * DEATH_SPIN_SPEED : undefined;
    drawBird({ x: 90, y: bird.y, vy: bird.vy }, true, null, dyingAngle);
    drawRaceBar();
  }

  // Easter egg: vẽ logo MU cố định trên bầu trời tại các mốc 40%/80% chiều dài map,
  // chỉ vẽ khi nằm trong tầm nhìn (dùng chung công thức camera với cột/chim khác).
  function drawGloryLogos() {
    if (!gloryLogoImg.complete || gloryLogoImg.naturalWidth === 0) return; // ảnh chưa tải xong thì bỏ qua, không lỗi
    const logoY = 90; // độ cao cố định gần đỉnh trời, phía trên các cột

    for (const logoWorldX of gloryLogoWorldXs) {
      const screenX = logoWorldX - worldOffset;
      if (screenX < -GLORY_LOGO_SIZE - VIEW_MARGIN || screenX > W + VIEW_MARGIN) continue;
      ctx.drawImage(
        gloryLogoImg,
        screenX - GLORY_LOGO_SIZE / 2,
        logoY - GLORY_LOGO_SIZE / 2,
        GLORY_LOGO_SIZE,
        GLORY_LOGO_SIZE
      );
    }
  }

  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#4ec0e9");
    sky.addColorStop(0.75, "#8fdcef");
    sky.addColorStop(1, "#cdf3f5");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
  }

  function drawMountains() {
    const t = (worldOffset * 0.3) % (W + 200);
    ctx.fillStyle = "rgba(60, 120, 90, 0.35)";
    drawMountainRow(t, H - GROUND_HEIGHT, 90, 55);
    ctx.fillStyle = "rgba(40, 95, 70, 0.4)";
    drawMountainRow(t * 1.4 + 80, H - GROUND_HEIGHT, 70, 40);
  }

  function drawMountainRow(offset, baseY, peakWidth, peakHeight) {
    ctx.beginPath();
    ctx.moveTo(-peakWidth - offset, baseY);
    for (let x = -peakWidth; x < W + peakWidth * 2; x += peakWidth) {
      const px = x - (offset % peakWidth);
      const py = baseY - (peakHeight + Math.sin(px * 0.02) * 12);
      ctx.lineTo(px, py);
      ctx.lineTo(px + peakWidth / 2, baseY);
    }
    ctx.lineTo(W + peakWidth * 2, baseY);
    ctx.closePath();
    ctx.fill();
  }

  function drawClouds() {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const t = frame * 0.15;
    for (let i = 0; i < 3; i++) {
      const cx = ((i * 220 - t) % (W + 200)) - 100;
      const cy = 70 + i * 130;
      drawCloud(cx, cy, 0.9 + i * 0.15);
    }
  }

  function drawCloud(cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.ellipse(0, 0, 40, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(28, 6, 30, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(-26, 6, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPipes() {
    // Camera: chim mình luôn hiện ở x=90 trên màn hình, và birdWorldX = worldOffset + 90
    // trong hệ tọa độ world tuyệt đối. Vậy screenX của 1 điểm world bất kỳ = worldX - birdWorldX + 90
    // = worldX - (worldOffset + 90) + 90 = worldX - worldOffset (KHÔNG cộng thêm 90 lần nữa,
    // nếu không cột sẽ vẽ lệch xa 90px so với vị trí dùng để tính va chạm thật).
    for (const pipe of pipes) {
      const screenX = pipe.worldX - worldOffset;
      if (screenX < -PIPE_WIDTH - VIEW_MARGIN || screenX > W + VIEW_MARGIN) continue;

      const topHeight = pipe.gapCenter - pipe.gap / 2;
      const bottomY = pipe.gapCenter + pipe.gap / 2;
      drawPipeSegment(screenX, 0, topHeight, true);
      drawPipeSegment(screenX, bottomY, H - GROUND_HEIGHT - bottomY, false);
    }
  }

  function drawPipeSegment(x, y, height, isTop) {
    if (height <= 0) return;
    const capHeight = 26;
    const capOverhang = 6;

    const body = ctx.createLinearGradient(x, 0, x + PIPE_WIDTH, 0);
    body.addColorStop(0, "#8fe07a");
    body.addColorStop(0.15, "#5fc95a");
    body.addColorStop(0.55, "#3aab48");
    body.addColorStop(1, "#2e8f3c");
    ctx.fillStyle = body;
    ctx.strokeStyle = "#1f6b2c";
    ctx.lineWidth = 3;

    const bodyY = isTop ? y : y + capHeight;
    const bodyHeight = Math.max(0, height - capHeight);
    ctx.fillRect(x, bodyY, PIPE_WIDTH, bodyHeight);
    ctx.strokeRect(x, bodyY, PIPE_WIDTH, bodyHeight);

    const capY = isTop ? y + height - capHeight : y;
    const capGrad = ctx.createLinearGradient(x - capOverhang, 0, x + PIPE_WIDTH + capOverhang, 0);
    capGrad.addColorStop(0, "#a3ec8d");
    capGrad.addColorStop(0.2, "#6bd464");
    capGrad.addColorStop(0.6, "#3aab48");
    capGrad.addColorStop(1, "#2a8536");
    ctx.fillStyle = capGrad;
    ctx.fillRect(x - capOverhang, capY, PIPE_WIDTH + capOverhang * 2, Math.min(capHeight, height));
    ctx.strokeRect(x - capOverhang, capY, PIPE_WIDTH + capOverhang * 2, Math.min(capHeight, height));

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x + 8, bodyY, 8, bodyHeight);
  }

  function drawGround() {
    const groundY = H - GROUND_HEIGHT;

    const dirt = ctx.createLinearGradient(0, groundY, 0, H);
    dirt.addColorStop(0, "#deb887");
    dirt.addColorStop(1, "#b8894f");
    ctx.fillStyle = dirt;
    ctx.fillRect(0, groundY, W, GROUND_HEIGHT);

    ctx.fillStyle = "#6fcf5a";
    ctx.fillRect(0, groundY, W, 10);
    ctx.fillStyle = "#5bb84a";
    const t = worldOffset % 24;
    for (let x = -24 - t; x < W + 24; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, groundY + 10);
      ctx.lineTo(x + 12, groundY);
      ctx.lineTo(x + 24, groundY + 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = "#4a9c3d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(W, groundY);
    ctx.stroke();
  }

  // Vẽ path hình chữ nhật bo góc, dùng ctx.roundRect() native nếu trình duyệt hỗ trợ
  // (Chrome 99+/Firefox 112+/Safari 16+), fallback tự vẽ bằng arcTo cho trình duyệt cũ hơn.
  function drawRoundedRectPath(x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Thanh đua: dải ngang mỏng nằm trong phần đất, hiển thị icon nhỏ của từng người chơi
  // theo % quãng đường (worldOffset) đã bay được so với tổng chiều dài map cố định.
  // Giúp mọi người luôn biết thứ hạng/khoảng cách dù camera không thấy nhau trực tiếp.
  function drawRaceBar() {
    if (!mapTotalLength) return;

    const barY = H - GROUND_HEIGHT + (GROUND_HEIGHT - RACE_BAR_HEIGHT) / 2;
    const barX = RACE_BAR_MARGIN_X;
    const barWidth = W - RACE_BAR_MARGIN_X * 2;

    // Nền dải đua
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    drawRoundedRectPath(barX, barY, barWidth, RACE_BAR_HEIGHT, RACE_BAR_HEIGHT / 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const progressToX = (worldOffsetValue) => {
      const ratio = Math.max(0, Math.min(1, worldOffsetValue / mapTotalLength));
      return barX + ratio * barWidth;
    };

    // Icon người chơi khác trước (để icon của mình luôn nổi lên trên nếu trùng vị trí)
    otherPlayers.forEach((p) => {
      if (!p.alive) return;
      const theirWorldOffset = p.renderWorldX - 90; // renderWorldX = worldOffset + 90, xem quy ước ở drawOtherBirds
      drawRaceBarIcon(progressToX(theirWorldOffset), barY + RACE_BAR_HEIGHT / 2, "#6cb6f0", "#2f6ea8");
    });

    // Icon của chính mình
    drawRaceBarIcon(progressToX(worldOffset), barY + RACE_BAR_HEIGHT / 2, "#ffc93c", "#c9891a");
  }

  function drawRaceBarIcon(x, y, fillColor, strokeColor) {
    ctx.beginPath();
    ctx.arc(x, y, RACE_BAR_HEIGHT / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawOtherBirds() {
    otherPlayers.forEach((p) => {
      if (!p.alive) return;
      // p.renderWorldX (đã nội suy từ buffer, xem updateOtherPlayersInterpolation) bao gồm sẵn +90,
      // cùng quy ước với birdWorldX = worldOffset + 90 của chính mình. Quy đổi sang màn hình theo
      // cùng công thức như cột: screenX = renderWorldX - worldOffset (không cộng thêm 90 lần nữa).
      const screenX = p.renderWorldX - worldOffset;

      if (screenX >= -VIEW_MARGIN && screenX <= W + VIEW_MARGIN) {
        // Trong tầm nhìn -> vẽ chim thật như bình thường
        drawBird({ x: screenX, y: p.renderY, vy: p.renderVy }, false, p.nickname);
      } else {
        // Ngoài tầm nhìn -> dán icon thu nhỏ sát mép trái/phải thay vì ẩn hẳn
        drawOffscreenIndicator(screenX, p.renderY);
      }
    });
  }

  // Dán icon thu nhỏ sát mép canvas cho người chơi hiện đang ở ngoài tầm nhìn.
  // screenX âm (< 0) -> họ ở phía sau mình -> dán mép trái. screenX > W -> họ ở phía trước -> dán mép phải.
  function drawOffscreenIndicator(screenX, worldY) {
    const isBehind = screenX < 0;
    const iconX = isBehind ? OFFSCREEN_ICON_MARGIN : W - OFFSCREEN_ICON_MARGIN;

    // Khoảng cách thật (px) từ mép tầm nhìn tới vị trí của họ, dùng để tính scale giảm dần
    const edgeX = isBehind ? -VIEW_MARGIN : W + VIEW_MARGIN;
    const distance = Math.abs(screenX - edgeX);
    const falloffRatio = Math.min(1, distance / OFFSCREEN_ICON_FALLOFF_DISTANCE);
    const scale = OFFSCREEN_ICON_MAX_SCALE - (OFFSCREEN_ICON_MAX_SCALE - OFFSCREEN_ICON_MIN_SCALE) * falloffRatio;

    // Kẹp y trong khung nhìn để icon không tràn lên đỉnh trời hoặc đè lên mặt đất/thanh đua
    const iconMarginY = 30;
    const iconY = Math.max(iconMarginY, Math.min(H - GROUND_HEIGHT - iconMarginY, worldY));

    ctx.save();
    ctx.translate(iconX, iconY);
    ctx.scale(scale, scale);

    // Icon dạng chim đơn giản hóa (không vẽ chi tiết cánh/mắt như chim thật, giữ nhẹ và rõ ở size nhỏ)
    const r = bird.radius;
    ctx.fillStyle = "#6cb6f0";
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2f6ea8";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Mũi tên chỉ hướng (trái/phải) để người chơi biết họ đang ở phía trước hay phía sau mình
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    if (isBehind) {
      ctx.moveTo(-r - 6, 0);
      ctx.lineTo(-r + 2, -5);
      ctx.lineTo(-r + 2, 5);
    } else {
      ctx.moveTo(r + 6, 0);
      ctx.lineTo(r - 2, -5);
      ctx.lineTo(r - 2, 5);
    }
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawBird(b, isSelf, nickname, overrideAngle) {
    ctx.save();
    ctx.translate(b.x, b.y);
    const angle =
      overrideAngle !== undefined
        ? overrideAngle
        : Math.max(-0.5, Math.min(0.9, b.vy / (MAX_FALL_SPEED * 0.6)));
    ctx.rotate(angle);

    const r = bird.radius;
    const wingFlap = Math.sin(frame * 0.4) * 0.5 + 0.5;

    ctx.fillStyle = isSelf ? "#e6a020" : "#c9891a";
    ctx.beginPath();
    ctx.moveTo(-r + 2, -2);
    ctx.lineTo(-r - 10, -8);
    ctx.lineTo(-r - 10, 4);
    ctx.closePath();
    ctx.fill();

    const bodyGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 2, 0, 0, r * 1.3);
    if (isSelf) {
      bodyGrad.addColorStop(0, "#ffe27a");
      bodyGrad.addColorStop(0.6, "#ffc93c");
      bodyGrad.addColorStop(1, "#f2a71b");
    } else {
      // Chim của người khác tô màu lạnh hơn (xanh dương) để phân biệt rõ với chim của mình
      bodyGrad.addColorStop(0, "#a9d8ff");
      bodyGrad.addColorStop(0.6, "#6cb6f0");
      bodyGrad.addColorStop(1, "#4a94d8");
    }
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isSelf ? "#c9891a" : "#2f6ea8";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 250, 225, 0.85)";
    ctx.beginPath();
    ctx.ellipse(-2, r * 0.35, r * 0.65, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(-2, 2);
    ctx.rotate(-0.3 + wingFlap * 0.6);
    ctx.fillStyle = isSelf ? "#e8901a" : "#3a7fbf";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.75, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isSelf ? "#b8720f" : "#2a5c8f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#ff6b4a";
    ctx.beginPath();
    ctx.moveTo(r - 3, -4);
    ctx.lineTo(r + 13, 0);
    ctx.lineTo(r - 3, 6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#d94f30";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(4, -6, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a2e";
    ctx.beginPath();
    ctx.arc(5.5, -6, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6.3, -7.2, 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    if (nickname) {
      drawNicknameBadge(b.x, b.y - r - 12, nickname, isSelf);
    }
  }

  // Nhãn tên dạng "pill" (nền tối mờ, bo tròn hết cỡ, viền màu riêng cho mình/người khác)
  // hiện phía trên đầu chim, giống nhãn tên trong các game nhiều người chơi phổ biến.
  // anchorX/anchorY là điểm giữa-dưới của nhãn (ngay trên đỉnh đầu chim).
  function drawNicknameBadge(anchorX, anchorY, nickname, isSelf) {
    ctx.save();
    ctx.font = "bold 12px Baloo 2, Nunito, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const paddingX = 8;
    const badgeHeight = 18;
    const textWidth = ctx.measureText(nickname).width;
    const badgeWidth = textWidth + paddingX * 2;

    const badgeX = anchorX - badgeWidth / 2;
    const badgeY = anchorY - badgeHeight;

    // Nền badge, tối mờ để luôn nổi rõ dù nền trời sáng hay tối
    ctx.fillStyle = "rgba(15, 20, 35, 0.72)";
    ctx.beginPath();
    drawRoundedRectPath(badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
    ctx.fill();

    // Viền màu riêng: vàng cho chính mình, xanh dương cho người khác - khớp màu thân chim
    ctx.strokeStyle = isSelf ? "rgba(255, 201, 60, 0.9)" : "rgba(108, 182, 240, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Chữ tên, có đổ bóng nhẹ để không bị chìm vào nền badge
    ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = 2;
    ctx.fillStyle = "#fff";
    ctx.fillText(nickname, anchorX, badgeY + badgeHeight / 2 + 1);

    ctx.restore();
  }

  // ----- Vòng lặp chính -----
  function loop(timestamp) {
    if (lastTime === null) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > MAX_DT) dt = MAX_DT;

    update(dt);
    draw();
    rafId = requestAnimationFrame(loop);
  }

  // ----- Input -----
  function handleInput(e) {
    if (e) e.preventDefault();
    if (state === "playing") flap();
  }

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") handleInput(e);
  });
  canvas.addEventListener("mousedown", handleInput);
  canvas.addEventListener("touchstart", handleInput, { passive: false });

  // ----- Đồng bộ mạng: buffered interpolation (kỹ thuật chuẩn dùng trong game FPS/MOBA) -----
  // Thay vì "đuổi theo" vị trí mới nhất bằng lerp (luôn trễ pha, giật khi mạng jitter),
  // ta giữ lại một buffer các snapshot {t, worldX, y, vy} gần nhất kèm timestamp cục bộ.
  // Khi vẽ, ta cố tình lùi lại RENDER_DELAY_MS (ví dụ 100ms) so với hiện tại, rồi nội suy
  // CHÍNH XÁC giữa 2 snapshot THẬT bao quanh thời điểm đó -> chuyển động mượt tuyệt đối
  // giữa các điểm dữ liệu có thật, và chịu được độ trễ/jitter mạng thay đổi thất thường
  // tốt hơn nhiều so với lerp đơn thuần.
  const RENDER_DELAY_MS = 100; // ~1.5 lần khoảng cách trung bình giữa 2 lần gửi (1000/15 ≈ 67ms)
  const MAX_BUFFER_SIZE = 30; // đủ chứa ~2 giây dữ liệu ở tần suất gửi hiện tại, tránh phình vô hạn

  Network.on("player:update", ({ id, worldOffset: theirWorldOffset, y, vy, angle, alive }) => {
    const existing = otherPlayers.get(id);
    const worldX = theirWorldOffset + 90; // +90 để khớp quy ước "chim ở world = worldOffset + 90"
    const snapshot = { t: performance.now(), worldX, y, vy };

    if (existing) {
      existing.buffer.push(snapshot);
      if (existing.buffer.length > MAX_BUFFER_SIZE) existing.buffer.shift();
      existing.alive = alive;
    } else {
      otherPlayers.set(id, {
        nickname: "?",
        buffer: [snapshot],
        renderWorldX: worldX,
        renderY: y,
        renderVy: vy,
        alive,
      });
    }
  });

  function updateOtherPlayersInterpolation() {
    const renderTime = performance.now() - RENDER_DELAY_MS;

    otherPlayers.forEach((p) => {
      const buf = p.buffer;
      if (buf.length === 0) return;

      // Dọn các snapshot đã quá cũ (chỉ giữ lại tối đa 1 điểm trước renderTime để làm mốc nội suy)
      while (buf.length > 2 && buf[1].t <= renderTime) buf.shift();

      if (buf.length === 1) {
        // Chưa đủ 2 điểm để nội suy (vừa mới có người khác vào phòng) -> dùng thẳng điểm duy nhất
        p.renderWorldX = buf[0].worldX;
        p.renderY = buf[0].y;
        p.renderVy = buf[0].vy;
        return;
      }

      const a = buf[0];
      const b = buf[1];

      if (renderTime <= a.t) {
        // renderTime rơi trước cả điểm cũ nhất trong buffer (vừa nhận dữ liệu, delay chưa kịp "chín")
        p.renderWorldX = a.worldX;
        p.renderY = a.y;
        p.renderVy = a.vy;
      } else if (renderTime >= b.t) {
        // renderTime vượt quá điểm mới nhất (mạng đang bị trễ/mất gói) -> ngoại suy nhẹ theo
        // vận tốc y báo cáo cuối cùng, thay vì đứng hình chờ gói tiếp theo.
        const extrapolateMs = Math.min(renderTime - b.t, 150); // giới hạn ngoại suy tối đa 150ms để tránh bay lố quá xa
        p.renderWorldX = b.worldX; // world X gắn với tốc độ cột cố định, không ngoại suy để tránh lệch camera
        p.renderY = b.y + b.vy * (extrapolateMs / 1000);
        p.renderVy = b.vy;
      } else {
        // Trường hợp chuẩn: nội suy chính xác giữa 2 snapshot thật bao quanh renderTime
        const span = b.t - a.t;
        const ratio = span > 0 ? (renderTime - a.t) / span : 0;
        p.renderWorldX = a.worldX + (b.worldX - a.worldX) * ratio;
        p.renderY = a.y + (b.y - a.y) * ratio;
        p.renderVy = a.vy + (b.vy - a.vy) * ratio;
      }
    });
  }

  function startNetworkSending() {
    stopNetworkSending();
    networkSendTimer = setInterval(() => {
      if (state === "playing" || state === "quiz") {
        Network.sendPlayerState({ worldOffset, y: bird.y, vy: bird.vy, angle: 0, alive: true });
      }
    }, NETWORK_SEND_INTERVAL * 1000);
  }

  function stopNetworkSending() {
    if (networkSendTimer) {
      clearInterval(networkSendTimer);
      networkSendTimer = null;
    }
  }

  // ----- API công khai -----
  function startMultiplayer({ seed, durationSec, room }) {
    document.getElementById("quiz-screen").classList.add("hidden");
    clearTimeout(respawnTimer);
    deathScreen.classList.add("hidden");
    Audio_.playBackground();

    rand = createSeededRandom(seed);
    bestScore = 0;
    frame = 0;
    matchEndAt = Date.now() + durationSec * 1000;
    pipes = generateFixedMap(durationSec); // map cố định chung, sinh 1 lần duy nhất cho cả trận
    mapTotalLength = pipes[pipes.length - 1].worldX; // dùng làm mốc 100% cho thanh đua

    // Logo MU đặt theo % số cột THỰC TẾ bay được trong đúng thời gian trận (không phải %
    // của map dự phòng dài hơn 1.5 lần ở trên) - ví dụ trận 90s, PIPE_SPEED hiện tại cho
    // ra ước lượng ~58 cột vượt được nếu bay liên tục không chết, logo1 đặt ở cột ~23 (40%),
    // logo2 ở cột ~47 (80%), quy đổi sang worldX bằng estimatedPipeCount * PIPE_SPACING.
    const estimatedPipeCount = (PIPE_SPEED * durationSec) / PIPE_SPACING;
    gloryLogoWorldXs = GLORY_LOGO_PERCENTAGES.map((pct) => estimatedPipeCount * pct * PIPE_SPACING);
    Audio_.stopGlory(); // đảm bảo sạch trạng thái glory từ trận trước (nếu có)

    otherPlayers = new Map();
    if (room && room.players) {
      room.players.forEach((p) => {
        if (p.id !== Network.id) {
          otherPlayers.set(p.id, {
            nickname: p.nickname,
            buffer: [{ t: performance.now(), worldX: 90, y: H / 2, vy: 0 }],
            renderWorldX: 90,
            renderY: H / 2,
            renderVy: 0,
            alive: true,
          });
        }
      });
    }

    resetRun();
    startNetworkSending();

    lastTime = null;
    if (rafId === null) {
      rafId = requestAnimationFrame(loop);
    }
  }

  function stop() {
    state = "idle";
    stopNetworkSending();
    Quiz.hide();
    document.getElementById("quiz-screen").classList.add("hidden");
    clearTimeout(respawnTimer);
    deathScreen.classList.add("hidden");
    Audio_.stopBackground(); // dừng nhạc nền khi rời trận (kể cả trường hợp giải tán phòng giữa chừng)
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  state = "idle";
  otherPlayers = new Map();

  return { startMultiplayer, stop };
})();
