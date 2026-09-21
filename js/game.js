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
  const NETWORK_SEND_INTERVAL = 1 / 15; // gửi vị trí chim của mình ~15 lần/giây

  let bird;
  let pipes; // map CỐ ĐỊNH, sinh 1 lần khi bắt đầu trận, mỗi cột có worldX tuyệt đối không đổi
  let score; // điểm của lượt chơi hiện tại (reset về 0 mỗi khi chết trong trận)
  let bestScore; // điểm cao nhất đạt được trong toàn trận, đây là điểm gửi lên server chấm
  let pipesSincePipeQuiz;
  let frame;
  let worldOffset; // quãng đường (px) mà CHÍNH MÌNH đã bay được kể từ đầu lượt chơi hiện tại -> dùng làm camera
  let state; // "idle" | "playing" | "quiz" | "dead"
  let rand; // seeded RNG dùng chung, đồng bộ giữa mọi người chơi trong phòng (chỉ dùng lúc sinh map 1 lần)
  let matchEndAt; // timestamp (ms) khi trận kết thúc
  let networkSendTimer;
  let otherPlayers; // Map<socketId, {nickname, targetWorldX, targetY, renderWorldX, renderY, vy, angle, alive}>
  let lastTime = null;
  let rafId = null;
  const VIEW_MARGIN = 80; // chỉ vẽ chim/cột khi nằm trong [-margin, W+margin] so với camera, để không lãng phí lúc quá xa

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
    }
  }

  function update(dt) {
    updateTimerHud();
    updateOtherPlayersInterpolation(dt);

    if (state !== "playing") return;
    frame++;

    bird.vy += GRAVITY * dt;
    if (bird.vy > MAX_FALL_SPEED) bird.vy = MAX_FALL_SPEED;
    bird.y += bird.vy * dt;

    worldOffset += PIPE_SPEED * dt;
    const birdWorldX = worldOffset + 90; // vị trí thật của chim trên map cố định (90 = x hiển thị trên màn hình)

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
          triggerQuiz();
          return;
        }
      }
    }

    if (bird.y + bird.radius > H - GROUND_HEIGHT || bird.y - bird.radius < 0) {
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
    // Luật: hết giờ mới kết thúc trận, ai điểm cao nhất thắng -> chết thì hồi sinh
    // lại từ vạch xuất phát (worldOffset = 0) sau ít giây, không phải chờ ai khác.
    // bestScore (điểm gửi server) không bị reset dù bay lại từ đầu map.
    state = "dead";
    Network.sendPlayerState({ worldOffset, y: bird.y, vy: bird.vy, angle: 0, alive: false });

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
    drawGround();
    drawOtherBirds();
    drawBird({ x: 90, y: bird.y, vy: bird.vy }, true, null);
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

  function drawOtherBirds() {
    otherPlayers.forEach((p) => {
      if (!p.alive) return;
      // p.renderWorldX đã bao gồm sẵn +90 (xem listener player:update: targetWorldX = theirWorldOffset + 90),
      // cùng quy ước với birdWorldX = worldOffset + 90 của chính mình. Quy đổi sang màn hình theo
      // cùng công thức như cột: screenX = renderWorldX - worldOffset (không cộng thêm 90 lần nữa).
      const screenX = p.renderWorldX - worldOffset;
      if (screenX < -VIEW_MARGIN || screenX > W + VIEW_MARGIN) return; // ngoài tầm nhìn -> ẩn hẳn
      drawBird({ x: screenX, y: p.renderY, vy: p.vy }, false, p.nickname);
    });
  }

  function drawBird(b, isSelf, nickname) {
    ctx.save();
    ctx.translate(b.x, b.y);
    const angle = Math.max(-0.5, Math.min(0.9, b.vy / (MAX_FALL_SPEED * 0.6)));
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
      ctx.save();
      ctx.font = "bold 12px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillText(nickname, b.x + 1, b.y - r - 9);
      ctx.fillStyle = "#fff";
      ctx.fillText(nickname, b.x, b.y - r - 10);
      ctx.restore();
    }
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

  // ----- Đồng bộ mạng -----
  // Server chỉ gửi vị trí người khác ~15 lần/giây (xem NETWORK_SEND_INTERVAL), trong khi
  // game vẽ lại ~60 lần/giây -> nếu vẽ thẳng theo vị trí mới nhận được, chim đối phương sẽ
  // "nhảy cóc" giật cục giữa các lần cập nhật. Để mượt, mỗi entry giữ thêm targetWorldX/targetY
  // (vị trí thật mới nhất từ server, theo world coordinate CỐ ĐỊNH trên map chung) tách biệt
  // với renderWorldX/renderY (vị trí đang vẽ), và mỗi frame trong update() sẽ kéo dần
  // renderWorldX/Y về targetWorldX/Y (nội suy tuyến tính - lerp).
  Network.on("player:update", ({ id, worldOffset: theirWorldOffset, y, vy, angle, alive }) => {
    const existing = otherPlayers.get(id);
    otherPlayers.set(id, {
      nickname: existing ? existing.nickname : "?",
      targetWorldX: theirWorldOffset + 90, // +90 để khớp quy ước "chim ở world = worldOffset + 90"
      targetY: y,
      renderWorldX: existing ? existing.renderWorldX : theirWorldOffset + 90,
      renderY: existing ? existing.renderY : y,
      vy,
      angle,
      alive,
    });
  });

  const INTERP_SPEED = 12; // hệ số lerp mỗi giây, càng lớn càng bám sát vị trí thật càng nhanh

  function updateOtherPlayersInterpolation(dt) {
    const t = Math.min(1, INTERP_SPEED * dt);
    otherPlayers.forEach((p) => {
      p.renderWorldX += (p.targetWorldX - p.renderWorldX) * t;
      p.renderY += (p.targetY - p.renderY) * t;
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

    rand = createSeededRandom(seed);
    bestScore = 0;
    frame = 0;
    matchEndAt = Date.now() + durationSec * 1000;
    pipes = generateFixedMap(durationSec); // map cố định chung, sinh 1 lần duy nhất cho cả trận

    otherPlayers = new Map();
    if (room && room.players) {
      room.players.forEach((p) => {
        if (p.id !== Network.id) {
          otherPlayers.set(p.id, {
            nickname: p.nickname,
            targetWorldX: 90,
            targetY: H / 2,
            renderWorldX: 90,
            renderY: H / 2,
            vy: 0,
            angle: 0,
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
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  state = "idle";
  otherPlayers = new Map();

  return { startMultiplayer, stop };
})();
