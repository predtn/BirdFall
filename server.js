// BirdFall multiplayer server.
// Quản lý phòng chơi trong bộ nhớ (không cần database vì phòng chỉ tồn tại tạm thời).
// Vai trò chính:
//  - Nhận nickname, tạo/join phòng.
//  - Đồng bộ seed ngẫu nhiên cho cột (mỗi người tự chạy vật lý/pattern cột cục bộ
//    nhưng ra kết quả giống hệt nhau nhờ cùng seed) -> không cần server broadcast cột.
//  - Broadcast vị trí chim của từng người để mọi người thấy nhau bay (giống .io).
//  - Đếm ngược, đếm giờ trận đấu, chấm điểm, gửi bảng tổng kết.

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

// Giới hạn số người/phòng: tối thiểu 2 (chơi 1 mình thì không cần phòng), tối đa 30
// (lưu ý hiệu năng O(N^2) của broadcast vị trí - ở 30 người là ~13000 msg/giây/phòng,
// vẫn ổn với host có đủ RAM/CPU nhưng là mức khá cao, dễ giật nếu host yếu).
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

function sanitizeAvatarId(id) {
  const n = Math.round(Number(id));
  if (!Number.isFinite(n) || n < 1 || n > AVATAR_COUNT) return 1; // mặc định avt_1 nếu giá trị không hợp lệ
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
    .map(([id, p]) => ({ id, nickname: p.nickname, score: p.score }))
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
  for (const p of room.players.values()) {
    p.score = 0;
    p.alive = true;
    p.hasFlag = false; // cờ MU là thành tựu riêng của TỪNG trận đấu, reset khi bắt đầu trận mới
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

  // Người chơi gửi trạng thái chim của mình lên, server broadcast lại cho cả phòng
  // (trừ chính người gửi) để render "chim của người khác". worldOffset = quãng đường
  // đã bay trên map cố định chung của trận (không phải x trên màn hình, vốn luôn = 90).
  socket.on("player:state", ({ worldOffset, y, vy, angle, alive }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.worldOffset = worldOffset;
    p.y = y;
    p.vy = vy;
    p.angle = angle;
    p.alive = alive;

    socket.to(room.code).emit("player:update", { id: socket.id, worldOffset, y, vy, angle, alive });
  });

  socket.on("player:score", ({ score }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.score = Math.max(p.score, Number(score) || 0);
    io.to(room.code).emit("player:scoreUpdate", { id: socket.id, score: p.score });
  });

  // Người chơi va chạm được vào logo MU (easter egg) -> đánh dấu skin cờ MU, giữ suốt
  // trận đấu (không mất khi chết/hồi sinh), broadcast cho CẢ phòng để mọi người đều thấy.
  socket.on("player:earnFlag", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || p.hasFlag) return; // đã có cờ rồi thì bỏ qua, tránh broadcast thừa
    p.hasFlag = true;
    io.to(room.code).emit("player:flagEarned", { id: socket.id });
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`BirdFall multiplayer server đang chạy tại http://localhost:${PORT}`);
});
