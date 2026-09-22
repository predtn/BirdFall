// Lobby module: điều phối toàn bộ luồng UI ngoài gameplay —
// nickname -> menu -> tạo/join phòng -> phòng chờ -> đếm ngược -> (chơi, xem game.js) -> bảng tổng kết.

const Lobby = (() => {
  let nickname = "";
  let currentRoom = null; // bản sao state phòng mới nhất nhận từ server
  let selectedAvatarId = 1;
  const AVATAR_COUNT = 10;

  // ----- DOM refs -----
  const screens = {
    nickname: document.getElementById("nickname-screen"),
    menu: document.getElementById("menu-screen"),
    create: document.getElementById("create-screen"),
    join: document.getElementById("join-screen"),
    waiting: document.getElementById("waiting-screen"),
    countdown: document.getElementById("countdown-screen"),
    results: document.getElementById("results-screen"),
  };
  const hud = document.getElementById("hud");

  const nicknameInput = document.getElementById("nickname-input");
  const nicknameConfirmBtn = document.getElementById("nickname-confirm-btn");
  const nicknameError = document.getElementById("nickname-error");
  const menuNicknameDisplay = document.getElementById("menu-nickname-display");
  const avatarGrid = document.getElementById("avatar-grid");

  const showCreateBtn = document.getElementById("show-create-btn");
  const showJoinBtn = document.getElementById("show-join-btn");

  const createRoomName = document.getElementById("create-room-name");
  const createRoomDuration = document.getElementById("create-room-duration");
  const createRoomMaxPlayers = document.getElementById("create-room-max-players");
  const createRoomBtn = document.getElementById("create-room-btn");
  const createBackBtn = document.getElementById("create-back-btn");
  const createError = document.getElementById("create-error");

  const joinRoomCode = document.getElementById("join-room-code");
  const joinRoomBtn = document.getElementById("join-room-btn");
  const joinBackBtn = document.getElementById("join-back-btn");
  const joinError = document.getElementById("join-error");

  const waitingRoomCode = document.getElementById("waiting-room-code");
  const waitingRoomName = document.getElementById("waiting-room-name");
  const waitingRoomDuration = document.getElementById("waiting-room-duration");
  const waitingRoomCapacity = document.getElementById("waiting-room-capacity");
  const waitingPlayerList = document.getElementById("waiting-player-list");
  const waitingStartBtn = document.getElementById("waiting-start-btn");
  const waitingLeaveBtn = document.getElementById("waiting-leave-btn");
  const waitingHint = document.getElementById("waiting-hint");

  const countdownNumber = document.getElementById("countdown-number");

  const resultsList = document.getElementById("results-list");
  const playAgainBtn = document.getElementById("play-again-btn");
  const disbandBtn = document.getElementById("disband-btn");
  const resultsHint = document.getElementById("results-hint");

  const toastEl = document.getElementById("toast");
  let toastHideTimer = null;

  // Toast thông báo ngắn, không chặn thao tác (thay cho window.alert() mặc định của trình duyệt).
  function showToast(message, durationMs = 3000) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    // ép reflow để transition "show" luôn chạy lại kể cả khi gọi toast liên tiếp
    void toastEl.offsetWidth;
    toastEl.classList.add("show");

    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => toastEl.classList.add("hidden"), 250);
    }, durationMs);
  }

  function showOnly(screenKey) {
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle("hidden", key !== screenKey);
    });
  }

  function isHost() {
    return currentRoom && currentRoom.hostId === Network.id;
  }

  // ----- Chọn avatar (ngay tại màn hình nickname) -----
  function renderAvatarGrid() {
    avatarGrid.innerHTML = "";
    for (let i = 1; i <= AVATAR_COUNT; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-option";
      if (i === selectedAvatarId) btn.classList.add("selected");
      btn.dataset.avatarId = i;

      const img = document.createElement("img");
      img.src = `assets/avt_${i}.png`;
      img.alt = `Avatar ${i}`;
      btn.appendChild(img);

      btn.addEventListener("click", () => {
        selectedAvatarId = i;
        avatarGrid.querySelectorAll(".avatar-option").forEach((el) => el.classList.remove("selected"));
        btn.classList.add("selected");
      });

      avatarGrid.appendChild(btn);
    }
  }

  // ----- Màn hình 1: nickname -----
  function confirmNickname() {
    const value = nicknameInput.value.trim();
    if (!value) {
      nicknameError.textContent = "Biệt danh đê!";
      return;
    }
    nickname = value.slice(0, 16);
    nicknameError.textContent = "";
    menuNicknameDisplay.textContent = nickname;
    showOnly("menu");
  }

  nicknameConfirmBtn.addEventListener("click", confirmNickname);
  nicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmNickname();
  });

  // ----- Màn hình 2: menu -----
  showCreateBtn.addEventListener("click", () => {
    createError.textContent = "";
    showOnly("create");
  });
  showJoinBtn.addEventListener("click", () => {
    joinError.textContent = "";
    showOnly("join");
  });
  createBackBtn.addEventListener("click", () => showOnly("menu"));
  joinBackBtn.addEventListener("click", () => showOnly("menu"));

  // ----- Màn hình 2a: tạo phòng -----
  createRoomBtn.addEventListener("click", async () => {
    createRoomBtn.disabled = true;
    const roomName = createRoomName.value.trim();
    const durationSec = Number(createRoomDuration.value) || 90;
    const maxPlayers = Number(createRoomMaxPlayers.value) || 8;
    const res = await Network.createRoom(nickname, roomName, durationSec, maxPlayers, selectedAvatarId);
    createRoomBtn.disabled = false;
    if (!res.ok) {
      createError.textContent = res.error || "Không tạo được phòng.";
      return;
    }
    currentRoom = res.room;
    renderWaitingRoom();
    showOnly("waiting");
  });

  // ----- Màn hình 2b: join phòng -----
  joinRoomBtn.addEventListener("click", async () => {
    const code = joinRoomCode.value.trim().toUpperCase();
    if (!code) {
      joinError.textContent = "Mã phòng đã chứ!";
      return;
    }
    joinRoomBtn.disabled = true;
    const res = await Network.joinRoom(nickname, code, selectedAvatarId);
    joinRoomBtn.disabled = false;
    if (!res.ok) {
      joinError.textContent = res.error || "Không vào được phòng.";
      return;
    }
    currentRoom = res.room;
    renderWaitingRoom();
    showOnly("waiting");
  });

  // ----- Màn hình 3: phòng chờ -----
  function renderWaitingRoom() {
    if (!currentRoom) return;
    waitingRoomCode.textContent = currentRoom.code;
    waitingRoomName.textContent = currentRoom.name;
    waitingRoomDuration.textContent = `Thời gian chơi: ${currentRoom.durationSec} giây`;
    waitingRoomCapacity.textContent = `Số người: ${currentRoom.players.length}/${currentRoom.maxPlayers}`;

    waitingPlayerList.innerHTML = "";
    currentRoom.players.forEach((p) => {
      const li = document.createElement("li");

      const avatarImg = document.createElement("img");
      avatarImg.className = "player-list-avatar";
      avatarImg.src = `assets/avt_${p.avatarId || 1}.png`;
      avatarImg.alt = "";
      li.appendChild(avatarImg);

      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.nickname;
      li.appendChild(nameSpan);

      if (p.isHost) {
        const tag = document.createElement("span");
        tag.className = "host-tag";
        tag.textContent = "Chủ phòng";
        li.appendChild(tag);
      }
      waitingPlayerList.appendChild(li);
    });

    const host = isHost();
    waitingStartBtn.classList.toggle("hidden", !host);
    waitingHint.textContent = host
      ? "Bấm Bắt đầu khi mọi người đã sẵn sàng."
      : "Đang đợi chủ phòng bấm Bắt đầu...";
  }

  waitingStartBtn.addEventListener("click", () => {
    Network.startMatch();
  });

  waitingLeaveBtn.addEventListener("click", () => {
    Network.leaveRoom();
    currentRoom = null;
    showOnly("menu");
  });

  // ----- Màn hình 4: đếm ngược -----
  Network.on("match:countdown", ({ count }) => {
    showOnly("countdown");
    countdownNumber.textContent = count;
    countdownNumber.style.animation = "none";
    // ép reflow để animation chạy lại mỗi lần đổi số
    void countdownNumber.offsetWidth;
    countdownNumber.style.animation = "";

    if (count === 3) Audio_.playCountdown(); // chỉ phát 1 lần lúc bắt đầu đếm ngược
  });

  // ----- Bắt đầu trận: chuyển quyền điều khiển sang game.js -----
  Network.on("match:started", ({ seed, durationSec }) => {
    showOnly(null); // ẩn hết overlay (kể cả countdown) để lộ canvas game
    hud.classList.remove("hidden");
    Game.startMultiplayer({ seed, durationSec, room: currentRoom });
  });

  // ----- Kết thúc trận: bảng tổng kết -----
  Network.on("match:ended", ({ results }) => {
    Game.stop();
    Audio_.playEnd();
    hud.classList.add("hidden");
    renderResults(results);
    showOnly("results");
  });

  function renderResults(results) {
    resultsList.innerHTML = "";
    results.forEach((r) => {
      const li = document.createElement("li");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = r.id === Network.id ? `${r.nickname} (bạn)` : r.nickname;
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "player-score";
      scoreSpan.textContent = r.score;
      li.appendChild(nameSpan);
      li.appendChild(scoreSpan);
      resultsList.appendChild(li);
    });

    const host = isHost();
    playAgainBtn.classList.toggle("hidden", !host);
    disbandBtn.classList.toggle("hidden", !host);
    resultsHint.textContent = host ? "" : "Đang đợi chủ phòng quyết định...";
  }

  playAgainBtn.addEventListener("click", () => {
    Network.playAgain();
  });

  disbandBtn.addEventListener("click", () => {
    Network.disbandRoom();
  });

  // ----- Đồng bộ state phòng (danh sách người chơi, host...) mọi lúc -----
  Network.on("room:state", (room) => {
    currentRoom = room;
    if (room.state === "lobby" && !screens.results.classList.contains("hidden")) {
      // "Chơi lại" -> quay về phòng chờ, dừng nhạc end đang phát
      Audio_.stopAll();
      renderWaitingRoom();
      showOnly("waiting");
      return;
    }
    if (!screens.waiting.classList.contains("hidden")) {
      renderWaitingRoom();
    }
  });

  Network.on("room:disbanded", () => {
    Game.stop();
    hud.classList.add("hidden");
    currentRoom = null;
    showOnly("menu");
    showToast("Tản giái");
  });

  // Click sound cho mọi nút bấm - event delegation ở cấp document, tự phủ cả nút sinh động
  // (đáp án quiz), không cần sửa gì khi thêm nút mới.
  document.addEventListener("click", (e) => {
    if (e.target.closest("button")) Audio_.playClick();
  });

  // ----- Khởi động -----
  Quiz.loadQuestions();
  renderAvatarGrid();
  showOnly("nickname");

  return {};
})();
