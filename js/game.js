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
  // Physics reverse-engineered từ Flappy Bird gốc (canvas 288x512 @60fps), quy đổi theo
  // SCALE rồi chuyển sang px/giây để nhân với deltaTime thực - tốc độ giống nhau ở mọi Hz màn hình.
  const REFERENCE_FPS = 60;
  const SCALE = W / 288; // tỉ lệ so với canvas gốc 288px chiều rộng

  const GRAVITY = 0.25 * SCALE * REFERENCE_FPS * REFERENCE_FPS; // px/s^2 (gốc: 0.25 px/frame^2 @288px)
  const FLAP_VELOCITY = -4.6 * SCALE * REFERENCE_FPS; // px/s (gốc: -4.6 px/frame)
  const MAX_FALL_SPEED = 10 * SCALE * REFERENCE_FPS; // px/s (gốc: 10 px/frame)
  const PIPE_GAP = Math.round(100 * SCALE); // px (gốc: 100px @288px rộng)
  const PIPE_WIDTH = 62;
  const PIPE_SPEED = 3 * 0.85 * 0.85 * 0.85 * SCALE * REFERENCE_FPS; // px/s (gốc: 3 px/frame, giảm tiết tấu ~39%)
  const PIPE_SPACING = Math.round(200 * SCALE); // px (gốc: 200px @288px rộng)
  const QUIZ_EVERY_N_PIPES = 3;
  const MAX_DT = 1 / 30; // tránh giật lag khi tab bị treo/đổi tab
  const GROUND_HEIGHT = 56; // dải đất ở đáy màn hình, chim chạm vào đây mới tính là rơi
  const PIPE_PATTERN_LENGTH = 3; // 1 pattern áp dụng cho mỗi 3 cột, khớp với nhịp quiz
  const PATTERN_CYCLE = ["easy", "normal", "hard", "zigzag"]; // lặp lại theo vòng, cứ ~4 cụm có 1 cụm "cao trào"
  const NETWORK_SEND_INTERVAL = 1 / 20; // gửi vị trí chim ~20 lần/giây cho buffered interpolation

  // ----- Hiệu ứng chết kiểu Mario -----
  // Chim bật ngược lên rồi rơi xoay tròn ra khỏi màn hình trước khi hiện overlay hồi sinh.
  // Thế giới (cột/người khác/camera) vẫn chạy bình thường, chỉ chim của mình rơi.
  const DEATH_BOUNCE_VELOCITY = -6 * SCALE * REFERENCE_FPS;
  const DEATH_GRAVITY = GRAVITY * 1.6;
  const DEATH_SPIN_SPEED = 10; // rad/giây
  const DEATH_ANIM_MAX_DURATION = 1.2; // giây, ngưỡng ép chuyển màn hình hồi sinh dù chưa rơi hết

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
  // Logo đặt ở 20%/60% số cột thực tế bay được TRONG ĐÚNG THỜI GIAN TRẬN (estimatedPipeCount,
  // tính trong startMultiplayer) - không phải % map dự phòng (dài gấp 1.5 lần để chịu được
  // chết/hồi sinh nhiều lần), vì theo % map dự phòng logo sẽ nằm quá xa, không ai tới được.
  // Nhạc glory dài ~18s không loop; GLORY_RANGE tính để fade in+out vừa khít trong đó.
  const GLORY_LOGO_PERCENTAGES = [0.15, 0.5];
  const GLORY_RANGE = 1600; // px mỗi bên logo, trong khoảng này crossfade dần
  const GLORY_LOGO_SIZE = 85; // 2/3 của 128, FLAG_HITBOX_RADIUS bên dưới tự scale theo
  let gloryLogoWorldXs = []; // worldX tuyệt đối của từng logo, tính 1 lần khi bắt đầu trận
  const gloryLogoImg = new Image();
  gloryLogoImg.src = "assets/MU.png";

  // ----- Skin cờ MU: thưởng khi va chạm vật lý thật vào logo (khác GLORY_RANGE, cần chạm
  // hẳn hitbox, không chỉ đi ngang qua) - đồng bộ qua mạng, giữ nguyên suốt trận. -----
  const FLAG_HITBOX_RADIUS = GLORY_LOGO_SIZE / 2;
  const FLAG_ICON_SIZE = 26;
  let hasFlag = false;
  const flagImg = new Image();
  flagImg.src = "assets/MU_flag.png";

  // ----- Lucky box: 5 hộp quà trải đều theo map, X nằm giữa 1 cặp cột liền kề gần mốc %
  // tương ứng, Y cố định sát trần/sát đất - đòi hỏi người chơi khéo léo né cột mới ăn được. -----
  const LUCKY_BOX_PERCENTAGES = [0.1, 0.3, 0.5, 0.7, 0.9];
  const LUCKY_BOX_SIZE = 53; // px hiển thị, to hơn 1/3 so với 40 gốc
  const LUCKY_BOX_HITBOX_RADIUS = LUCKY_BOX_SIZE / 2;
  let luckyBoxes = []; // [{ worldX, y, collected }]
  let luckyBoxCount = 0; // số hộp đã nhặt trong trận hiện tại (persistent qua chết/hồi sinh)
  const luckyBoxHud = document.getElementById("lucky-box-hud");
  const luckyBoxImg = new Image();
  luckyBoxImg.src = "assets/lucky_box.png";

  // ----- Skill sét đánh: sạc đầy sau LIGHTNING_CHARGE_NEEDED câu trả lời đúng liên tiếp,
  // dùng để triệu hồi sét đánh chết 2 người chơi ngẫu nhiên khác (không mất bestScore, chỉ
  // phải bay lại từ đầu giống chết bình thường). Server làm trọng tài toàn bộ (đếm charge,
  // chọn nạn nhân) - client chỉ hiển thị HUD và vẽ hiệu ứng theo lệnh server gửi về. -----
  const LIGHTNING_CHARGE_NEEDED = 5;
  const LIGHTNING_BOLT_DURATION_MS = 500; // hiệu ứng tia sét hiện trên màn hình bao lâu
  let myLightningCharge = 0;
  let activeLightningBolts = []; // [{ worldX, y, startTime }] - vẽ trong draw(), tự dọn khi hết hạn
  const lightningSkillHud = document.getElementById("lightning-skill-hud");
  const lightningSkillIcon = document.getElementById("lightning-skill-icon");
  const lightningSkillCount = document.getElementById("lightning-skill-count");

  function updateLightningSkillHud() {
    lightningSkillCount.textContent = `${myLightningCharge}/${LIGHTNING_CHARGE_NEEDED}`;
    lightningSkillIcon.classList.toggle("ready", myLightningCharge >= LIGHTNING_CHARGE_NEEDED);
  }

  lightningSkillIcon.addEventListener("click", () => {
    if (myLightningCharge >= LIGHTNING_CHARGE_NEEDED && state === "playing") {
      Network.useLightningSkill();
    }
  });

  // ----- Feed thông báo sự kiện (chết/nhặt quà/chạm easter egg MU), góc trên trái -----
  const EVENT_FEED_DURATION_MS = 3000;
  const eventFeedEl = document.getElementById("event-feed");
  let myNickname = "Bạn"; // set trong startMultiplayer() từ room.players

  function pushEventFeed(text, cssClass) {
    const item = document.createElement("div");
    item.className = `event-feed-item ${cssClass}`;
    item.textContent = text;
    eventFeedEl.appendChild(item);
    setTimeout(() => {
      item.classList.add("fade-out");
      setTimeout(() => item.remove(), 400); // đợi hết transition opacity rồi mới gỡ khỏi DOM
    }, EVENT_FEED_DURATION_MS);
  }

  // ----- Avatar nhân vật -----
  // Hitbox (bird.radius) giữ nguyên không đổi; avatar vẽ to hơn 1 chút để nhìn rõ mặt,
  // người chơi vẫn né theo hitbox nhỏ hơn ẩn bên trong.
  const AVATAR_DISPLAY_SCALE = 1.7;
  const AVATAR_COUNT = 10;
  const avatarImgs = {}; // { [avatarId]: HTMLImageElement }
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const img = new Image();
    img.src = `assets/avt_${i}.png`;
    avatarImgs[i] = img;
  }
  let myAvatarId = 1; // set trong startMultiplayer() từ room.players

  // ----- Sinh map cố định 1 lần khi bắt đầu trận -----
  // Map cố định chung cho mọi người chơi để so sánh vị trí công bằng.
  function generateFixedMap(durationSec) {
    const margin = 60;
    let lastGapCenter = H / 2;
    const result = [];

    // +50% dự phòng vì người chơi có thể chết/hồi sinh nhiều lần trong cùng thời gian trận.
    const totalWorldLength = PIPE_SPEED * durationSec * 1.5;
    const pipeCount = Math.ceil(totalWorldLength / PIPE_SPACING) + 5;

    for (let pipeIndex = 0; pipeIndex < pipeCount; pipeIndex++) {
      const worldX = 400 + pipeIndex * PIPE_SPACING; // 400px đầu là khoảng trống an toàn
      const cycleIndex = Math.floor(pipeIndex / PIPE_PATTERN_LENGTH) % PATTERN_CYCLE.length;
      const pattern = PATTERN_CYCLE[cycleIndex];
      const posInPattern = pipeIndex % PIPE_PATTERN_LENGTH;

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

  // Sinh vị trí 5 lucky box, mỗi hộp đặt giữa 1 cặp cột liền kề gần mốc % tương ứng nhất
  // (không phải đúng % tuyệt đối, vì X phải nằm giữa 2 cột). Y cố định sát trần/sát đất
  // (xem bên dưới) - có thể chồng lên cột, đòi hỏi người chơi né cột đúng lúc mới ăn được.
  function generateLuckyBoxes(fixedPipes) {
    const totalLength = fixedPipes[fixedPipes.length - 1].worldX;
    const boxes = [];

    for (let boxIndex = 0; boxIndex < LUCKY_BOX_PERCENTAGES.length; boxIndex++) {
      const pct = LUCKY_BOX_PERCENTAGES[boxIndex];
      const targetX = pct * totalLength;

      // Tìm cặp cột liền kề (before, after) mà targetX rơi vào khoảng giữa chúng
      let pairIndex = 0;
      for (let i = 0; i < fixedPipes.length - 1; i++) {
        if (fixedPipes[i].worldX <= targetX) pairIndex = i;
      }
      const before = fixedPipes[pairIndex];
      const after = fixedPipes[Math.min(pairIndex + 1, fixedPipes.length - 1)];

      // Đặt hộp giữa khoảng trống ngang giữa 2 cột (sau mép phải cột trước, trước mép trái cột sau)
      const leftEdge = before.worldX + PIPE_WIDTH;
      const rightEdge = after.worldX;
      const worldX = (leftEdge + rightEdge) / 2;

      // Để buộc người chơi phải khéo léo lách qua cột mới ăn được: hộp đặt cố định cách
      // trần 50px hoặc cách đất 50px (random 50/50 lên/xuống), KHÔNG kẹp theo khe hở cột -
      // có thể chồng lên thân cột ở gần đó, người chơi phải né cột đúng lúc để lấy được.
      const goUp = rand() < 0.5;
      const y = goUp ? 70 : H - GROUND_HEIGHT - 50;

      boxes.push({ boxIndex, worldX, y, collected: false });
    }

    return boxes;
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
      Audio_.playJump();
    }
  }

  // Proximity (0..1) tới logo MU gần nhất, dựa trên vị trí thật của CHÍNH MÌNH -
  // chỉ mình nghe crossfade khi chính mình tới gần logo.
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

  // Va chạm vật lý thật (hitbox tròn, giống check cột) với từng logo MU - chạm 1 trong 2 là đủ.
  function checkFlagCollision(birdWorldX) {
    if (hasFlag) return;
    const logoY = 90; // phải khớp đúng logoY dùng trong drawGloryLogos()

    for (const logoX of gloryLogoWorldXs) {
      const dx = birdWorldX - logoX;
      const dy = bird.y - logoY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < bird.radius + FLAG_HITBOX_RADIUS) {
        hasFlag = true;
        Network.earnFlag();
        break;
      }
    }
  }

  // Va chạm vật lý thật (hitbox tròn) với từng lucky box chưa nhặt. Chỉ có 5 hộp/map DÙNG
  // CHUNG cho cả phòng - ai chạm trước thì hộp biến mất với TẤT CẢ mọi người. Ẩn ngay tại
  // đây (optimistic, để không có độ trễ hình ảnh chờ mạng), nhưng chỉ cộng điểm HUD khi
  // server xác nhận qua "player:luckyBoxCollected" (tránh cộng nhầm nếu người khác lấy trước).
  function checkLuckyBoxCollision(birdWorldX) {
    for (const box of luckyBoxes) {
      if (box.collected) continue;
      const dx = birdWorldX - box.worldX;
      const dy = bird.y - box.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < bird.radius + LUCKY_BOX_HITBOX_RADIUS) {
        box.collected = true; // ẩn ngay cục bộ, không chờ xác nhận server
        Network.collectLuckyBox(box.boxIndex);
      }
    }
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
    checkFlagCollision(birdWorldX);
    checkLuckyBoxCollision(birdWorldX);

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
          // Quiz KHÔNG tắt/pause glory glory - nhạc tiếp tục phát xuyên suốt popup.
          triggerQuiz();
          return;
        }
      }
    }

    if (bird.y + bird.radius > H - GROUND_HEIGHT || bird.y - bird.radius < 0) {
      Audio_.stopGlory();
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
          Audio_.stopGlory();
          return handleDeath();
        }
      }
    }
  }

  const RESPAWN_DELAY_SEC = 3;
  const deathScreen = document.getElementById("death-screen");
  const deathCountdownNumber = document.getElementById("death-countdown-number");
  let respawnTimer = null;

  function handleDeath(feedText, deathCause) {
    // worldOffset đứng yên khi chết; người khác vẫn interpolate theo world offset thật
    // của họ nên vẫn thấy họ "trôi qua". dying=true + deathStartY/deathStartVy cho người
    // khác tự tính lại animation xoay+rơi bằng công thức vật lý đóng (xem drawOtherBirds),
    // không cần server gửi update liên tục trong lúc chết. deathCause cho người khác biết
    // để hiện đúng feedback ("chết vì ngu" hay "bị sét đánh") thay vì luôn hiện mặc định.
    state = "dying";
    deathAnimElapsed = 0;
    bird.vy = DEATH_BOUNCE_VELOCITY;
    Network.sendPlayerState({
      worldOffset,
      y: bird.y,
      vy: bird.vy,
      angle: 0,
      alive: false,
      dying: true,
      deathStartY: bird.y,
      deathStartVy: bird.vy,
      deathCause: deathCause || "normal",
    });
    Audio_.playDie();
    pushEventFeed(feedText || `${myNickname} đã chết vì ngu`, "event-death");
  }

  function updateDeathAnimation(dt) {
    deathAnimElapsed += dt;

    bird.vy += DEATH_GRAVITY * dt;
    bird.y += bird.vy * dt;

    const fellOffScreen = bird.y - bird.radius > H;
    const timedOut = deathAnimElapsed >= DEATH_ANIM_MAX_DURATION;
    if (fellOffScreen || timedOut) {
      showDeathOverlay();
    }
  }

  function showDeathOverlay() {
    // Chết -> hồi sinh từ vạch xuất phát (worldOffset = 0), không chờ ai khác.
    // bestScore không reset dù bay lại từ đầu map.
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
        void deathCountdownNumber.offsetWidth; // ép reflow để animation chạy lại
        deathCountdownNumber.style.animation = "";
        respawnTimer = setTimeout(tick, 1000);
      } else {
        deathScreen.classList.add("hidden");
        Audio_.restoreBackground();
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
    drawLuckyBoxes();
    drawGround();
    drawOtherBirds();
    const dyingAngle = state === "dying" ? deathAnimElapsed * DEATH_SPIN_SPEED : undefined;
    drawBird({ x: 90, y: bird.y, vy: bird.vy }, true, null, dyingAngle, hasFlag, myAvatarId);
    drawLightningBolts();
    drawRaceBar();
  }

  // Vẽ tia sét zigzag ngẫu nhiên từ đỉnh màn hình đánh thẳng xuống đúng vị trí world của nạn
  // nhân tại thời điểm bị đánh (không đuổi theo họ di chuyển sau đó, vì đây chỉ là hiệu ứng
  // chớp nhoáng ~500ms). Fade dần theo thời gian, tự dọn khỏi mảng khi hết hạn.
  function drawLightningBolts() {
    if (activeLightningBolts.length === 0) return;
    const now = performance.now();

    activeLightningBolts = activeLightningBolts.filter((bolt) => now - bolt.startTime < LIGHTNING_BOLT_DURATION_MS);

    for (const bolt of activeLightningBolts) {
      const screenX = bolt.worldX - worldOffset;
      if (screenX < -VIEW_MARGIN || screenX > W + VIEW_MARGIN) continue;

      const elapsed = now - bolt.startTime;
      const progress = elapsed / LIGHTNING_BOLT_DURATION_MS;
      const alpha = progress < 0.3 ? 1 : Math.max(0, 1 - (progress - 0.3) / 0.7); // giữ sáng rõ đầu rồi fade

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "#e8f4ff";
      ctx.lineWidth = 4;
      ctx.shadowColor = "#8fd8ff";
      ctx.shadowBlur = 18;
      ctx.beginPath();

      // Zigzag ngẫu nhiên (seedless - chỉ hiệu ứng hình ảnh, không cần đồng bộ chính xác
      // giữa các client) từ đỉnh màn hình xuống đúng bolt.y
      const segments = 7;
      let x = bolt.worldX - worldOffset;
      let y = 0;
      ctx.moveTo(x, y);
      for (let i = 1; i <= segments; i++) {
        const targetY = (bolt.y / segments) * i;
        x = screenX + (Math.random() - 0.5) * 30;
        y = targetY;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Easter egg: vẽ logo MU tại các mốc GLORY_LOGO_PERCENTAGES, dùng chung công thức
  // camera với cột/chim khác.
  function drawGloryLogos() {
    if (!gloryLogoImg.complete || gloryLogoImg.naturalWidth === 0) return;
    const logoY = 90;

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

  // Vẽ 5 lucky box chưa nhặt, dùng chung công thức camera với cột/logo.
  function drawLuckyBoxes() {
    if (!luckyBoxImg.complete || luckyBoxImg.naturalWidth === 0) return;

    for (const box of luckyBoxes) {
      if (box.collected) continue;
      const screenX = box.worldX - worldOffset;
      if (screenX < -LUCKY_BOX_SIZE - VIEW_MARGIN || screenX > W + VIEW_MARGIN) continue;
      ctx.drawImage(
        luckyBoxImg,
        screenX - LUCKY_BOX_SIZE / 2,
        box.y - LUCKY_BOX_SIZE / 2,
        LUCKY_BOX_SIZE,
        LUCKY_BOX_SIZE
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
    // Camera: birdWorldX = worldOffset + 90, chim hiện ở x=90 màn hình.
    // screenX = worldX - birdWorldX + 90 = worldX - worldOffset (KHÔNG cộng thêm 90 lần nữa,
    // nếu không cột sẽ vẽ lệch 90px so với vị trí va chạm thật).
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

  // Dùng ctx.roundRect() native nếu trình duyệt hỗ trợ, fallback arcTo cho trình duyệt cũ.
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

  // Thanh đua: hiển thị icon từng người theo % quãng đường đã bay so với tổng map.
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

    const raceBarIconRadius = RACE_BAR_HEIGHT / 2 - 2;

    // Vẽ người khác trước để icon của mình nổi lên trên nếu trùng vị trí
    otherPlayers.forEach((p) => {
      if (!p.alive) return;
      const theirWorldOffset = p.renderWorldX - 90;
      drawAvatar(progressToX(theirWorldOffset), barY + RACE_BAR_HEIGHT / 2, raceBarIconRadius, false, p.avatarId);
    });

    // Icon của chính mình
    drawAvatar(progressToX(worldOffset), barY + RACE_BAR_HEIGHT / 2, raceBarIconRadius, true, myAvatarId);
  }

  function drawOtherBirds() {
    otherPlayers.forEach((p) => {
      if (p.dying) {
        drawDyingOtherBird(p);
        return;
      }
      if (!p.alive) return;
      // p.renderWorldX đã bao gồm +90, cùng quy ước birdWorldX = worldOffset + 90 -> screenX = renderWorldX - worldOffset
      const screenX = p.renderWorldX - worldOffset;

      if (screenX >= -VIEW_MARGIN && screenX <= W + VIEW_MARGIN) {
        drawBird({ x: screenX, y: p.renderY, vy: p.renderVy }, false, p.nickname, undefined, p.hasFlag, p.avatarId);
      } else {
        drawOffscreenIndicator(screenX, p.renderY, p.avatarId);
      }
    });
  }

  // Vẽ animation chết kiểu Mario cho người chơi khác: dùng công thức vật lý đóng
  // (y = y0 + v0*t + 0.5*a*t², vy = v0 + a*t) để tự tính lại vị trí/góc xoay cục bộ
  // từ mốc deathAnimStartClientTime, không cần server gửi update liên tục lúc chết.
  function drawDyingOtherBird(p) {
    const elapsed = (performance.now() - p.deathAnimStartClientTime) / 1000;
    if (elapsed >= DEATH_ANIM_MAX_DURATION) {
      p.dying = false;
      return;
    }

    const y = p.deathStartY + p.deathStartVy * elapsed + 0.5 * DEATH_GRAVITY * elapsed * elapsed;
    if (y - bird.radius > H) {
      p.dying = false;
      return;
    }

    const screenX = p.deathWorldX - worldOffset;
    const angle = elapsed * DEATH_SPIN_SPEED;
    if (screenX >= -VIEW_MARGIN && screenX <= W + VIEW_MARGIN) {
      drawBird({ x: screenX, y, vy: 0 }, false, p.nickname, angle, p.hasFlag, p.avatarId);
    }
  }

  // screenX < 0 -> họ ở phía sau -> dán mép trái. screenX > W -> phía trước -> dán mép phải.
  function drawOffscreenIndicator(screenX, worldY, avatarId) {
    const isBehind = screenX < 0;
    const iconX = isBehind ? OFFSCREEN_ICON_MARGIN : W - OFFSCREEN_ICON_MARGIN;

    const edgeX = isBehind ? -VIEW_MARGIN : W + VIEW_MARGIN;
    const distance = Math.abs(screenX - edgeX);
    const falloffRatio = Math.min(1, distance / OFFSCREEN_ICON_FALLOFF_DISTANCE);
    const scale = OFFSCREEN_ICON_MAX_SCALE - (OFFSCREEN_ICON_MAX_SCALE - OFFSCREEN_ICON_MIN_SCALE) * falloffRatio;

    const iconMarginY = 30;
    const iconY = Math.max(iconMarginY, Math.min(H - GROUND_HEIGHT - iconMarginY, worldY));

    ctx.save();
    ctx.translate(iconX, iconY);
    ctx.scale(scale, scale);

    const r = bird.radius;
    drawAvatar(0, 0, r, false, avatarId);

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

  // Vẽ avatar (assets/avt_{avatarId}.png) tại (cx, cy), giữ nguyên tỉ lệ khung hình gốc
  // (không crop mất đầu/đít) - dùng chung cho chim chính, chim khác, race bar, off-screen.
  function drawAvatar(cx, cy, displayRadius, isSelf, avatarId) {
    const displayHeight = displayRadius * 2;
    const avatarImg = avatarImgs[avatarId] || avatarImgs[1];
    if (avatarImg.complete && avatarImg.naturalWidth > 0) {
      const aspect = avatarImg.naturalWidth / avatarImg.naturalHeight;
      const displayWidth = displayHeight * aspect;
      ctx.drawImage(avatarImg, cx - displayWidth / 2, cy - displayHeight / 2, displayWidth, displayHeight);
    } else {
      ctx.fillStyle = isSelf ? "#ffc93c" : "#6cb6f0";
      ctx.fillRect(cx - displayRadius, cy - displayRadius, displayHeight, displayHeight);
    }
  }

  function drawBird(b, isSelf, nickname, overrideAngle, hasFlagSkin, avatarId) {
    ctx.save();
    ctx.translate(b.x, b.y);
    const angle =
      overrideAngle !== undefined
        ? overrideAngle
        : Math.max(-0.5, Math.min(0.9, b.vy / (MAX_FALL_SPEED * 0.6)));
    ctx.rotate(angle);

    const r = bird.radius;
    drawAvatar(0, 0, r * AVATAR_DISPLAY_SCALE, isSelf, avatarId);

    // Cờ vẽ TRƯỚC ctx.restore() (còn trong hệ tọa độ đã rotate) để cán cờ xoay cùng chim -
    // nếu không xoay theo sẽ trông như trôi nổi tách rời khỏi đầu.
    if (hasFlagSkin) {
      drawFlagOnHead(0, -r * AVATAR_DISPLAY_SCALE);
    }

    ctx.restore();

    if (nickname) {
      drawNicknameBadge(b.x, b.y - r - 12, nickname, isSelf);
    }
  }

  // Neo chân cột cờ (không phải góc ảnh) vào (headX, headTopY) - đỉnh đầu-giữa avatar.
  // Chân cột trong ảnh gốc (439x378) nằm ở khoảng (83%, 97%) kích thước ảnh, đo bằng mắt.
  const FLAG_POLE_BASE_X_RATIO = 0.83;
  const FLAG_POLE_BASE_Y_RATIO = 0.97;

  function drawFlagOnHead(headX, headTopY) {
    if (!flagImg.complete || flagImg.naturalWidth === 0) return;
    const aspect = flagImg.naturalWidth / flagImg.naturalHeight;
    const flagHeight = FLAG_ICON_SIZE;
    const flagWidth = flagHeight * aspect;

    const poleBaseX = flagWidth * FLAG_POLE_BASE_X_RATIO;
    const poleBaseY = flagHeight * FLAG_POLE_BASE_Y_RATIO;

    ctx.drawImage(flagImg, headX - poleBaseX, headTopY - poleBaseY, flagWidth, flagHeight);
  }

  // Nhãn tên dạng "pill" phía trên đầu chim. anchorX/anchorY là điểm giữa-dưới của nhãn.
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

    ctx.fillStyle = "rgba(15, 20, 35, 0.72)";
    ctx.beginPath();
    drawRoundedRectPath(badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
    ctx.fill();

    ctx.strokeStyle = isSelf ? "rgba(255, 201, 60, 0.9)" : "rgba(108, 182, 240, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

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

  // ----- Đồng bộ mạng: buffered interpolation (kỹ thuật chuẩn game FPS/MOBA) -----
  // Giữ buffer snapshot {t, worldX, y, vy}, vẽ lùi lại RENDER_DELAY_MS rồi nội suy chính xác
  // giữa 2 snapshot thật bao quanh thời điểm đó - mượt hơn lerp đơn thuần, chịu jitter tốt hơn.
  const RENDER_DELAY_MS = 100;
  const MAX_BUFFER_SIZE = 30; // ~2 giây dữ liệu ở tần suất gửi hiện tại

  Network.on("player:update", ({ id, worldOffset: theirWorldOffset, y, vy, angle, alive, dying, deathStartY, deathStartVy, deathCause }) => {
    const existing = otherPlayers.get(id);
    const worldX = theirWorldOffset + 90;
    const snapshot = { t: performance.now(), worldX, y, vy };

    // dying=true -> không đưa vào buffer interpolation bình thường (họ đứng yên khi chết),
    // thay vào đó lưu mốc bắt đầu để tự tính lại animation xoay+rơi cục bộ (xem drawOtherBirds).
    if (dying) {
      if (existing) {
        if (!existing.dying) {
          const feedText =
            deathCause === "lightning"
              ? `${existing.nickname} đã bị sét đánh trúng` // đã hiện lúc nhận player:lightningStrike rồi nên bỏ qua ở đây
              : `${existing.nickname} đã chết vì ngu`;
          if (deathCause !== "lightning") pushEventFeed(feedText, "event-death");
        }
        existing.dying = true;
        existing.deathAnimStartClientTime = performance.now();
        existing.deathStartY = deathStartY;
        existing.deathStartVy = deathStartVy;
        existing.deathWorldX = worldX;
      }
      return;
    }

    if (existing) {
      existing.buffer.push(snapshot);
      if (existing.buffer.length > MAX_BUFFER_SIZE) existing.buffer.shift();
      existing.alive = alive;
      existing.dying = false;
    } else {
      otherPlayers.set(id, {
        nickname: "?",
        avatarId: 1,
        buffer: [snapshot],
        renderWorldX: worldX,
        renderY: y,
        renderVy: vy,
        alive,
        dying: false,
        hasFlag: false,
      });
    }
  });

  // Người khác vừa đạt cờ MU -> đánh dấu để vẽ cờ trên đầu họ, giữ nguyên suốt trận.
  Network.on("player:flagEarned", ({ id, nickname }) => {
    const p = otherPlayers.get(id);
    if (p) p.hasFlag = true;
    pushEventFeed(`${id === Network.id ? myNickname : nickname} đã vào hang`, "event-flag");
  });

  // Server xác nhận 1 lucky box đã được ai đó nhặt (chỉ 5 hộp DÙNG CHUNG cho cả phòng) -
  // ẩn hộp đó với TẤT CẢ mọi người (kể cả người chưa kịp bay tới), và chỉ cộng điểm HUD
  // nếu chính mình là người server xác nhận đã nhặt (winnerId === Network.id).
  Network.on("player:luckyBoxCollected", ({ boxIndex, winnerId, winnerNickname }) => {
    const box = luckyBoxes[boxIndex];
    if (box) box.collected = true;
    pushEventFeed(`${winnerId === Network.id ? myNickname : winnerNickname} đã được chương trình bố thí quà`, "event-lucky-box");
    if (winnerId === Network.id) {
      luckyBoxCount++;
      luckyBoxHud.textContent = String(luckyBoxCount);
    }
  });

  // Server xác nhận sạc thêm charge (sau mỗi câu trả lời đúng) hoặc reset về 0 (sau khi dùng
  // skill) - chỉ áp dụng cho CHÍNH MÌNH, người khác không cần biết charge của nhau.
  Network.on("player:lightningCharge", ({ id, charge }) => {
    if (id !== Network.id) return;
    myLightningCharge = charge;
    updateLightningSkillHud();
  });

  // Có người dùng skill sét đánh - server đã chọn sẵn 2 nạn nhân ngẫu nhiên, TẤT CẢ mọi
  // người trong phòng (kể cả người dùng skill) đều thấy hiệu ứng tia sét đánh xuống đúng vị
  // trí world hiện tại của từng nạn nhân. Nạn nhân tự kích hoạt animation chết cục bộ của
  // chính họ (dùng lại handleDeath() có sẵn) khi nhận ra mình nằm trong danh sách victims.
  Network.on("player:lightningStrike", ({ casterId, casterNickname, victims }) => {
    const casterDisplayName = casterId === Network.id ? myNickname : casterNickname;
    pushEventFeed(`${casterDisplayName} đã triệu hồi sét đánh!`, "event-lightning");
    Audio_.playLightning(); // mỗi client tự phát local khi nhận broadcast -> cả phòng đều nghe

    victims.forEach(({ id, nickname }) => {
      let strikeWorldX, strikeY;
      if (id === Network.id) {
        strikeWorldX = worldOffset + 90;
        strikeY = bird.y;
      } else {
        const p = otherPlayers.get(id);
        if (!p) return; // họ có thể đã rời phòng đúng lúc này, bỏ qua an toàn
        strikeWorldX = p.renderWorldX;
        strikeY = p.renderY;
      }
      activeLightningBolts.push({ worldX: strikeWorldX, y: strikeY, startTime: performance.now() });

      if (id === Network.id) {
        // Sét đánh vẫn giết được kể cả khi đang mở popup quiz (state === "quiz") - đóng popup
        // trước rồi mới kích hoạt chết, tránh bug "đang trả lời câu hỏi thì miễn nhiễm sét".
        // Không giết khi đang "dying"/"dead" (đã chết/hồi sinh dở, tránh chồng animation).
        if (state === "playing" || state === "quiz") {
          if (state === "quiz") Quiz.hide(true); // force: hủy timer nội bộ của quiz, tránh chúng tự đè state="playing" lên "dying" sau đó
          handleDeath(`${myNickname} đã bị sét đánh trúng`, "lightning");
        }
      } else {
        pushEventFeed(`${nickname} đã bị sét đánh trúng`, "event-death");
      }
    });
  });

  // Dọn "chim ma": nếu ai đó rời phòng giữa trận (F5, mất mạng, thoát tab) mà không kịp
  // gửi trạng thái alive:false cuối cùng, chim của họ sẽ đứng yên vĩnh viễn trên màn hình
  // người khác vì otherPlayers không có cơ chế tự dọn - room:state là nguồn sự thật cho
  // danh sách người còn trong phòng, nên cứ mỗi lần nhận, xóa khỏi otherPlayers bất kỳ id
  // nào không còn xuất hiện trong room.players nữa.
  Network.on("room:state", (room) => {
    if (!otherPlayers || !room || !room.players) return;
    const stillInRoom = new Set(room.players.map((p) => p.id));
    otherPlayers.forEach((_, id) => {
      if (!stillInRoom.has(id)) otherPlayers.delete(id);
    });
  });

  function updateOtherPlayersInterpolation() {
    const renderTime = performance.now() - RENDER_DELAY_MS;

    otherPlayers.forEach((p) => {
      const buf = p.buffer;
      if (buf.length === 0) return;

      // Chỉ giữ tối đa 1 điểm trước renderTime để làm mốc nội suy
      while (buf.length > 2 && buf[1].t <= renderTime) buf.shift();

      if (buf.length === 1) {
        p.renderWorldX = buf[0].worldX;
        p.renderY = buf[0].y;
        p.renderVy = buf[0].vy;
        return;
      }

      const a = buf[0];
      const b = buf[1];

      if (renderTime <= a.t) {
        p.renderWorldX = a.worldX;
        p.renderY = a.y;
        p.renderVy = a.vy;
      } else if (renderTime >= b.t) {
        // Mạng trễ/mất gói -> ngoại suy nhẹ theo vận tốc y cuối cùng thay vì đứng hình
        const extrapolateMs = Math.min(renderTime - b.t, 150);
        p.renderWorldX = b.worldX; // world X không ngoại suy, tránh lệch camera
        p.renderY = b.y + b.vy * (extrapolateMs / 1000);
        p.renderVy = b.vy;
      } else {
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
    pipes = generateFixedMap(durationSec);
    mapTotalLength = pipes[pipes.length - 1].worldX; // mốc 100% cho thanh đua

    // Logo MU đặt theo % số cột thực tế bay được trong đúng thời gian trận (xem
    // generateFixedMap ở trên để hiểu vì sao không dùng % map dự phòng).
    const estimatedPipeCount = (PIPE_SPEED * durationSec) / PIPE_SPACING;
    gloryLogoWorldXs = GLORY_LOGO_PERCENTAGES.map((pct) => estimatedPipeCount * pct * PIPE_SPACING);
    Audio_.stopGlory();
    hasFlag = false;

    luckyBoxes = generateLuckyBoxes(pipes);
    luckyBoxCount = 0;
    luckyBoxHud.textContent = "0";
    eventFeedEl.innerHTML = ""; // dọn feed sự kiện của trận trước (kể cả khi "Chơi lại")

    myLightningCharge = 0;
    activeLightningBolts = [];
    updateLightningSkillHud();

    otherPlayers = new Map();
    myAvatarId = 1;
    if (room && room.players) {
      room.players.forEach((p) => {
        if (p.id === Network.id) {
          myAvatarId = p.avatarId || 1;
          myNickname = p.nickname || "Bạn";
        } else {
          otherPlayers.set(p.id, {
            nickname: p.nickname,
            avatarId: p.avatarId || 1,
            buffer: [{ t: performance.now(), worldX: 90, y: H / 2, vy: 0 }],
            renderWorldX: 90,
            renderY: H / 2,
            renderVy: 0,
            alive: true,
            dying: false,
            hasFlag: !!p.hasFlag,
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
    Quiz.hide(true);
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
