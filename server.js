// ╔═══════════════════════════════════════════════════════════════╗
// ║           🎰 CHAOSBUTTON - SERVER.JS                          ║
// ║           Node.js + Express + Socket.io                       ║
// ║           npm install express socket.io                       ║
// ╚═══════════════════════════════════════════════════════════════╝

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB für Bild-Uploads
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────────
//  ROOM STORAGE
// ─────────────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode -> Room-Objekt

function generateCode(len = 6) {
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, len);
}

function createRoom({ name, host, maxPlayers, isPrivate, category, roundDuration, rounds }) {
  const code = generateCode();
  const room = {
    code,
    name: name || `Room #${code}`,
    host,
    maxPlayers: Math.min(maxPlayers || 8, 20),
    isPrivate: !!isPrivate,
    category: category || "Free Chaos",
    roundDuration: roundDuration || 120, // Sekunden
    rounds: rounds || 3,
    players: [],         // { id, name, avatar, score }
    state: "lobby",      // lobby | editor | voting | results
    currentRound: 0,
    submissions: [],     // { playerId, name, buttonData, votes:[] }
    roundTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getPublicRooms() {
  return [...rooms.values()]
    .filter((r) => !r.isPrivate && r.state === "lobby")
    .map((r) => ({
      code: r.code,
      name: r.name,
      host: r.host,
      players: r.players.length,
      maxPlayers: r.maxPlayers,
      category: r.category,
      roundDuration: r.roundDuration,
      rounds: r.rounds,
    }));
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────
//  GAME LOGIC HELPERS
// ─────────────────────────────────────────────────────────────────
function startRound(room) {
  room.currentRound++;
  room.state = "editor";
  room.submissions = [];

  io.to(room.code).emit("round:start", {
    round: room.currentRound,
    totalRounds: room.rounds,
    duration: room.roundDuration,
    category: room.category,
  });

  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    endEditing(room);
  }, room.roundDuration * 1000);

  broadcastRoomUpdate(room);
}

function endEditing(room) {
  clearTimeout(room.roundTimer);
  room.state = "voting";
  
  // Submissions vorbereiten – shuffled
  const shuffled = [...room.submissions].sort(() => Math.random() - 0.5);
  io.to(room.code).emit("voting:start", { submissions: shuffled });
  broadcastRoomUpdate(room);
}

function tallyVotes(room) {
  room.state = "results";

  const tally = room.submissions.map((sub) => {
    const avg =
      sub.votes.length > 0
        ? sub.votes.reduce((a, b) => a + b, 0) / sub.votes.length
        : 0;
    // Score zum Player addieren
    const player = room.players.find((p) => p.id === sub.playerId);
    if (player) player.score = (player.score || 0) + Math.round(avg * 10);
    return { ...sub, avgScore: avg.toFixed(2) };
  });

  tally.sort((a, b) => b.avgScore - a.avgScore);

  io.to(room.code).emit("results:show", {
    tally,
    players: room.players,
    round: room.currentRound,
    isFinal: room.currentRound >= room.rounds,
  });

  broadcastRoomUpdate(room);

  // Nächste Runde oder Finale
  if (room.currentRound < room.rounds) {
    setTimeout(() => startRound(room), 8000);
  } else {
    setTimeout(() => endGame(room), 12000);
  }
}

function endGame(room) {
  room.state = "gameover";
  const sorted = [...room.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  io.to(room.code).emit("game:over", { leaderboard: sorted });
  broadcastRoomUpdate(room);

  // Room nach 5 Min aufräumen
  setTimeout(() => {
    rooms.delete(room.code);
    io.to(room.code).emit("room:closed");
  }, 5 * 60 * 1000);
}

function broadcastRoomUpdate(room) {
  io.to(room.code).emit("room:update", {
    players: room.players,
    state: room.state,
    currentRound: room.currentRound,
    code: room.code,
    name: room.name,
    maxPlayers: room.maxPlayers,
    category: room.category,
  });
  // Public-Room-Liste refreshen
  io.emit("rooms:list", getPublicRooms());
}

// ─────────────────────────────────────────────────────────────────
//  HTTP ROUTES
// ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health Check fuer Railway
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/rooms", (req, res) => {
  res.json(getPublicRooms());
});

app.get("/api/room/:code", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    code: room.code,
    name: room.name,
    players: room.players.length,
    maxPlayers: room.maxPlayers,
    state: room.state,
    isPrivate: room.isPrivate,
  });
});

// ─────────────────────────────────────────────────────────────────
//  SOCKET.IO EVENTS
// ─────────────────────────────────────────────────────────────────
const CATEGORIES = [
  "🎮 Game Button",
  "💥 Destruction Chaos",
  "🎵 Sound Machine",
  "🎨 Art Attack",
  "🤪 Meme Lord",
  "⚡ Speed Run",
  "👻 Horror Click",
  "🌈 Rainbow Madness",
];

io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // Beim Connect direkt Public Rooms senden
  socket.emit("rooms:list", getPublicRooms());

  // ── ROOM ERSTELLEN ──────────────────────────────────────────────
  socket.on("room:create", ({ playerName, settings }, cb) => {
    if (!playerName?.trim()) return cb?.({ error: "Name required" });

    const room = createRoom({
      name: settings.roomName,
      host: playerName,
      maxPlayers: settings.maxPlayers,
      isPrivate: settings.isPrivate,
      category: settings.category || CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)],
      roundDuration: settings.roundDuration,
      rounds: settings.rounds,
    });

    const player = {
      id: socket.id,
      name: playerName.trim(),
      avatar: settings.avatar || "⚡",
      score: 0,
      isHost: true,
    };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerName = playerName;

    io.emit("rooms:list", getPublicRooms());

    cb?.({ success: true, room: { code: room.code, name: room.name, category: room.category } });
    broadcastRoomUpdate(room);
    console.log(`🏠 Room created: ${room.code} by ${playerName}`);
  });

  // ── ROOM BEITRETEN ──────────────────────────────────────────────
  socket.on("room:join", ({ code, playerName, avatar }, cb) => {
    const room = getRoom(code);
    if (!room) return cb?.({ error: "Room not found 🤷" });
    if (room.state !== "lobby") return cb?.({ error: "Game already started! ⏰" });
    if (room.players.length >= room.maxPlayers) return cb?.({ error: "Room is full 😵" });
    if (room.players.find((p) => p.name === playerName?.trim())) {
      return cb?.({ error: "Name already taken 👀" });
    }

    const player = {
      id: socket.id,
      name: playerName.trim(),
      avatar: avatar || "🎯",
      score: 0,
      isHost: false,
    };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerName = playerName;

    io.to(room.code).emit("player:joined", { player });
    cb?.({ success: true, room: { code: room.code, name: room.name, category: room.category, state: room.state, players: room.players } });
    broadcastRoomUpdate(room);
    console.log(`👤 ${playerName} joined room ${room.code}`);
  });

  // ── GAME STARTEN (nur Host) ─────────────────────────────────────
  socket.on("game:start", (_, cb) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: "Room not found" });
    const player = room.players.find((p) => p.id === socket.id);
    if (!player?.isHost) return cb?.({ error: "Only host can start!" });
    if (room.players.length < 1) return cb?.({ error: "Need at least 1 player!" });
    if (room.state !== "lobby") return cb?.({ error: "Game already running" });

    startRound(room);
    cb?.({ success: true });
  });

  // ── BUTTON SUBMISSION ───────────────────────────────────────────
  socket.on("button:submit", ({ buttonData }, cb) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.state !== "editor") return cb?.({ error: "Not in editor phase" });

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ error: "Player not found" });

    // Duplicate check
    const existing = room.submissions.find((s) => s.playerId === socket.id);
    if (existing) {
      existing.buttonData = buttonData;
    } else {
      room.submissions.push({
        playerId: socket.id,
        playerName: player.name,
        playerAvatar: player.avatar,
        buttonData,
        votes: [],
        submittedAt: Date.now(),
      });
    }

    cb?.({ success: true });
    io.to(room.code).emit("submission:count", { count: room.submissions.length, total: room.players.length });
    console.log(`📤 ${player.name} submitted button`);

    // Alle eingereicht? → sofort in Voting
    if (room.submissions.length >= room.players.length) {
      clearTimeout(room.roundTimer);
      endEditing(room);
    }
  });

  // ── VOTE ABGEBEN ────────────────────────────────────────────────
  socket.on("vote:cast", ({ targetPlayerId, stars }, cb) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.state !== "voting") return cb?.({ error: "Not in voting phase" });
    if (targetPlayerId === socket.id) return cb?.({ error: "No self-voting!" });

    const sub = room.submissions.find((s) => s.playerId === targetPlayerId);
    if (!sub) return cb?.({ error: "Submission not found" });

    // Nur eine Stimme pro Voter pro Submission
    const voteIdx = sub.votes.findIndex?.((v) => v?.voterId === socket.id);
    if (voteIdx !== undefined && voteIdx >= 0) {
      sub.votes[voteIdx] = { voterId: socket.id, stars };
    } else {
      sub.votes.push({ voterId: socket.id, stars });
    }

    cb?.({ success: true });

    // Alle gevotet?
    const allVoted = room.submissions.every((s) =>
      room.players
        .filter((p) => p.id !== s.playerId)
        .every((p) => s.votes.some((v) => v.voterId === p.id))
    );
    if (allVoted) {
      // Votes als flache Zahlen
      room.submissions.forEach(s => {
        s.votes = s.votes.map(v => typeof v === "object" ? v.stars : v);
      });
      tallyVotes(room);
    }
  });

  // ── EDITOR FERTIG melden ────────────────────────────────────────
  socket.on("editor:done", (_, cb) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: "Room not found" });
    const player = room.players.find((p) => p.id === socket.id);
    if (!player?.isHost) return cb?.({ error: "Only host can skip" });
    clearTimeout(room.roundTimer);
    endEditing(room);
    cb?.({ success: true });
  });

  // ── CHAT ────────────────────────────────────────────────────────
  socket.on("chat:send", ({ message }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !message?.trim()) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    io.to(room.code).emit("chat:message", {
      player: player.name,
      avatar: player.avatar,
      message: message.trim().slice(0, 200),
      ts: Date.now(),
    });
  });

  // ── ROOM VERLASSEN ──────────────────────────────────────────────
  socket.on("room:leave", () => handleLeave(socket));
  socket.on("disconnect", () => handleLeave(socket));

  function handleLeave(sock) {
    const room = getRoom(sock.data.roomCode);
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === sock.id);
    if (idx === -1) return;
    const [left] = room.players.splice(idx, 1);
    sock.leave(room.code);

    io.to(room.code).emit("player:left", { playerName: left.name });
    console.log(`👋 ${left.name} left room ${room.code}`);

    if (room.players.length === 0) {
      clearTimeout(room.roundTimer);
      rooms.delete(room.code);
      io.emit("rooms:list", getPublicRooms());
      return;
    }

    // Host übertragen
    if (left.isHost && room.players.length > 0) {
      room.players[0].isHost = true;
      room.host = room.players[0].name;
      io.to(room.code).emit("host:changed", { newHost: room.players[0].name });
    }

    broadcastRoomUpdate(room);
  }

  // ── CATEGORIES ABRUFEN ──────────────────────────────────────────
  socket.on("categories:get", (_, cb) => {
    cb?.(CATEGORIES);
  });

  // ── DEBUG ───────────────────────────────────────────────────────
  socket.on("debug:rooms", (_, cb) => {
    cb?.([...rooms.values()].map((r) => ({ code: r.code, players: r.players.length, state: r.state })));
  });
});

// ─────────────────────────────────────────────────────────────────
//  SERVER START
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Railway bindet auf 0.0.0.0 — lokal laeuft es auf localhost
server.listen(PORT, "0.0.0.0", () => {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  console.log(`
╔══════════════════════════════════════════════╗
║  🎰  CHAOSBUTTON SERVER laeuft!               ║
║  🌐  ${domain.padEnd(38)}║
║  🔌  Socket.io aktiv                         ║
╚══════════════════════════════════════════════╝
`);
});

module.exports = { app, server, io };
