// Network module: bọc Socket.IO client, expose các hàm gọi tới server
// và một hệ thống "on" đơn giản để các module khác (lobby.js, game.js) lắng nghe sự kiện.

const Network = (() => {
  const socket = io();
  const listeners = {};

  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  }

  function emitLocal(event, payload) {
    (listeners[event] || []).forEach((cb) => cb(payload));
  }

  // Các sự kiện server tự đẩy xuống (không cần callback trả lời trực tiếp)
  socket.on("room:state", (room) => emitLocal("room:state", room));
  socket.on("match:countdown", (data) => emitLocal("match:countdown", data));
  socket.on("match:started", (data) => emitLocal("match:started", data));
  socket.on("match:ended", (data) => emitLocal("match:ended", data));
  socket.on("room:disbanded", () => emitLocal("room:disbanded"));
  socket.on("player:update", (data) => emitLocal("player:update", data));
  socket.on("player:scoreUpdate", (data) => emitLocal("player:scoreUpdate", data));

  function createRoom(nickname, roomName, durationSec, maxPlayers) {
    return new Promise((resolve) => {
      socket.emit("room:create", { nickname, roomName, durationSec, maxPlayers }, resolve);
    });
  }

  function joinRoom(nickname, roomCode) {
    return new Promise((resolve) => {
      socket.emit("room:join", { nickname, roomCode }, resolve);
    });
  }

  function startMatch() {
    socket.emit("room:start");
  }

  function playAgain() {
    socket.emit("room:playAgain");
  }

  function disbandRoom() {
    socket.emit("room:disband");
  }

  function leaveRoom() {
    socket.emit("room:leave");
  }

  function sendPlayerState(state) {
    socket.emit("player:state", state);
  }

  function sendScore(score) {
    socket.emit("player:score", { score });
  }

  return {
    get id() {
      return socket.id;
    },
    on,
    createRoom,
    joinRoom,
    startMatch,
    playAgain,
    disbandRoom,
    leaveRoom,
    sendPlayerState,
    sendScore,
  };
})();
