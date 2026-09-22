// BirdFall multiplayer server.
// Quản lý phòng chơi trong bộ nhớ (RAM, không cần database vì phòng chỉ tồn tại tạm thời).
// Đồng bộ seed ngẫu nhiên cho cột thay vì broadcast từng cột: mỗi client tự sinh map
// giống hệt nhau từ cùng seed.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MIN_DURATION_SEC = process.env.BIRDFALL_MIN_DURATION
  ? Number(process.env.BIRDFALL_MIN_DURATION)
  : 30; // cho phép hạ sàn khi chạy test tự động, mặc định 30s khi chơi thật

// Tối đa 30: broadcast vị trí là O(N^2), ở 30 người là ~13000 msg/giây/phòng - mức cao,
// dễ giật nếu host yếu.
const MIN_ROOM_PLAYERS = 2;
const MAX_ROOM_PLAYERS = 30;
const DEFAULT_ROOM_PLAYERS = 8;

function clampMaxPlayers(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ROOM_PLAYERS;
  return Math.max(MIN_ROOM_PLAYERS, Math.min(MAX_ROOM_PLAYERS, n));
}

app.use(express.static(path.join(__dirname)));

// ----- State -----
// rooms: Map<roomCode, Room>
// Room = {
//   code, name, durationSec, maxPlayers, hostId,
//   state: "lobby" | "countdown" | "playing" | "finished",
//   seed: number,
//   players: Map<socketId, { nickname, score, alive, x, y, vy, angle, finished }>,
//   startedAt: number (ms, khi bắt đầu "playing"),
//   timer: NodeJS.Timeout | null
// }
const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm (I, O, 0, 1)
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function sanitizeNickname(name) {
  return String(name || "").trim().slice(0, 16) || "Ẩn danh";
}

const AVATAR_COUNT = 10; // khớp đúng số file assets/avt_1.png .. avt_10.png
const LUCKY_BOX_TOTAL = 5; // khớp đúng số lucky box sinh ra mỗi trận (xem LUCKY_BOX_PERCENTAGES ở client)

function sanitizeAvatarId(id) {
  const n = Math.round(Number(id));
  if (!Number.isFinite(n) || n < 1 || n > AVATAR_COUNT) return 1;
  return n;
}

function roomPublicState(room) {
  return {
    code: room.code,
    name: room.name,
    durationSec: room.durationSec,
    maxPlayers: room.maxPlayers,
    state: room.state,
    hostId: room.hostId,
    players: [...room.players.entries()].map(([id, p]) => ({
      id,
      nickname: p.nickname,
      avatarId: p.avatarId,
      score: p.score,
      alive: p.alive,
      hasFlag: !!p.hasFlag,
      isHost: id === room.hostId,
    })),
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit("room:state", roomPublicState(room));
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function endMatch(room) {
  if (room.state !== "playing") return;
  clearRoomTimer(room);
  room.state = "finished";

  const results = [...room.players.entries()]
    .map(([id, p]) => ({
      id,
      nickname: p.nickname,
      score: p.score,
      hasFlag: !!p.hasFlag,
      luckyBoxCount: p.luckyBoxCount || 0,
    }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit("match:ended", { results });
  broadcastRoomState(room);
}

function startCountdown(room) {
  room.state = "countdown";
  broadcastRoomState(room);

  let count = 3;
  io.to(room.code).emit("match:countdown", { count });
  const tick = () => {
    count--;
    if (count > 0) {
      io.to(room.code).emit("match:countdown", { count });
      room.timer = setTimeout(tick, 1000);
    } else {
      startMatch(room);
    }
  };
  room.timer = setTimeout(tick, 1000);
}

function startMatch(room) {
  room.state = "playing";
  room.seed = Math.floor(Math.random() * 2 ** 31);
  room.startedAt = Date.now();
  room.collectedBoxIndexes = new Set(); // chỉ 5 hộp DÙNG CHUNG cho cả phòng, reset mỗi trận mới
  for (const p of room.players.values()) {
    p.score = 0;
    p.alive = true;
    p.hasFlag = false; // reset mỗi trận mới
    p.luckyBoxCount = 0;
  }

  io.to(room.code).emit("match:started", {
    seed: room.seed,
    durationSec: room.durationSec,
  });
  broadcastRoomState(room);

  clearRoomTimer(room);
  room.timer = setTimeout(() => endMatch(room), room.durationSec * 1000);
}

function removePlayerFromRoom(socketId) {
  for (const room of rooms.values()) {
    if (!room.players.has(socketId)) continue;

    room.players.delete(socketId);

    if (room.players.size === 0) {
      clearRoomTimer(room);
      rooms.delete(room.code);
      continue;
    }

    // Nếu host rời phòng, chuyển quyền host cho người còn lại đầu tiên
    if (room.hostId === socketId) {
      room.hostId = room.players.keys().next().value;
    }

    broadcastRoomState(room);
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ nickname, roomName, durationSec, maxPlayers, avatarId }, cb) => {
    const code = makeRoomCode();
    const room = {
      code,
      name: String(roomName || "").trim().slice(0, 24) || `Phòng ${code}`,
      durationSec: Math.max(MIN_DURATION_SEC, Math.min(600, Number(durationSec) || 90)),
      maxPlayers: clampMaxPlayers(maxPlayers),
      hostId: socket.id,
      state: "lobby",
      seed: 0,
      players: new Map(),
      startedAt: 0,
      timer: null,
    };
    room.players.set(socket.id, {
      nickname: sanitizeNickname(nickname),
      avatarId: sanitizeAvatarId(avatarId),
      score: 0,
      alive: true,
      hasFlag: false,
      luckyBoxCount: 0,
      worldOffset: 0,
      y: 320,
      vy: 0,
      angle: 0,
    });
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    cb({ ok: true, room: roomPublicState(room) });
  });

  socket.on("room:join", ({ nickname, roomCode, avatarId }, cb) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      cb({ ok: false, error: "Không tìm thấy phòng. Kiểm tra lại mã phòng nhé." });
      return;
    }
    if (room.state !== "lobby") {
      cb({ ok: false, error: "Trận đã bắt đầu, không thể vào phòng lúc này. Đợi ván sau nhé." });
      return;
    }
    if (room.players.size >= room.maxPlayers) {
      cb({ ok: false, error: `Phòng đã đầy (tối đa ${room.maxPlayers} người).` });
      return;
    }

    room.players.set(socket.id, {
      nickname: sanitizeNickname(nickname),
      avatarId: sanitizeAvatarId(avatarId),
      score: 0,
      alive: true,
      hasFlag: false,
      luckyBoxCount: 0,
      worldOffset: 0,
      y: 320,
      vy: 0,
      angle: 0,
    });

    socket.join(code);
    socket.data.roomCode = code;

    cb({ ok: true, room: roomPublicState(room) });
    broadcastRoomState(room);
  });

  socket.on("room:start", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return; // chỉ chủ phòng được bấm bắt đầu
    if (room.state !== "lobby") return;
    if (room.players.size < 1) return;
    startCountdown(room);
  });

  socket.on("room:playAgain", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.state !== "finished") return;
    room.state = "lobby";
    for (const p of room.players.values()) {
      p.score = 0;
      p.alive = true;
    }
    broadcastRoomState(room);
  });

  socket.on("room:disband", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    clearRoomTimer(room);
    io.to(room.code).emit("room:disbanded");
    rooms.delete(room.code);
  });

  socket.on("room:leave", () => {
    removePlayerFromRoom(socket.id);
    socket.data.roomCode = null;
  });

  // Broadcast vị trí chim cho cả phòng trừ người gửi. worldOffset = quãng đường đã bay
  // trên map cố định (không phải x màn hình, luôn = 90).
  socket.on("player:state", ({ worldOffset, y, vy, angle, alive, dying, deathStartY, deathStartVy }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.worldOffset = worldOffset;
    p.y = y;
    p.vy = vy;
    p.angle = angle;
    p.alive = alive;

    socket.to(room.code).emit("player:update", {
      id: socket.id,
      worldOffset,
      y,
      vy,
      angle,
      alive,
      dying,
      deathStartY,
      deathStartVy,
    });
  });

  socket.on("player:score", ({ score }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.score = Math.max(p.score, Number(score) || 0);
    io.to(room.code).emit("player:scoreUpdate", { id: socket.id, score: p.score });
  });

  // Easter egg: va chạm logo MU -> gắn skin cờ, giữ suốt trận, broadcast cho cả phòng.
  socket.on("player:earnFlag", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || p.hasFlag) return;
    p.hasFlag = true;
    io.to(room.code).emit("player:flagEarned", { id: socket.id, nickname: p.nickname });
  });

  // Lucky box: chỉ 5 hộp DÙNG CHUNG cho cả phòng (không phải riêng từng người) - server làm
  // trọng tài theo boxIndex, ai chạm trước thì thắng, những người chạm sau (dù optimistic đã
  // ẩn cục bộ ở client) không được cộng điểm. Broadcast cho CẢ phòng để hộp biến mất với
  // mọi người ngay lập tức, không chỉ người thắng.
  socket.on("player:collectLuckyBox", ({ boxIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const index = Number(boxIndex);
    if (!Number.isInteger(index) || index < 0 || index >= LUCKY_BOX_TOTAL) return;
    if (room.collectedBoxIndexes.has(index)) return; // đã có người khác nhặt trước, bỏ qua

    room.collectedBoxIndexes.add(index);
    p.luckyBoxCount = (p.luckyBoxCount || 0) + 1;
    io.to(room.code).emit("player:luckyBoxCollected", { boxIndex: index, winnerId: socket.id, winnerNickname: p.nickname });
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`BirdFall multiplayer server đang chạy tại http://localhost:${PORT}`);
});
