// server/index.js
import http from "http";
import { WebSocketServer } from "ws";

// server/players.js
var PLAYER_COLORS = [
  { name: "Alpine White", hex: 16317180, css: "#ffffff" },
  { name: "Marina Bay Blue", hex: 165063, css: "#0284c7" },
  { name: "Toronto Red", hex: 15680580, css: "#ef4444" },
  { name: "Isle of Man Green", hex: 1096065, css: "#10b981" },
  { name: "Sao Paulo Yellow", hex: 16096779, css: "#f59e0b" },
  { name: "Velvet Purple", hex: 9133302, css: "#8b5cf6" },
  { name: "Kyalami Orange", hex: 16007006, css: "#f43f5e" },
  { name: "Electric Cyan", hex: 440020, css: "#06b6d4" }
];
var Player = class {
  constructor(id, ws, name = "Racer", colorIndex = 0) {
    this.id = id;
    this.ws = ws;
    this.name = name;
    this.colorIndex = colorIndex % PLAYER_COLORS.length;
    this.isReady = false;
    this.isHost = false;
    this.roomCode = null;
    this.gridPosition = 0;
    this.pos = { x: 0, y: 0.15, z: 0 };
    this.rot = 0;
    this.speed = 0;
    this.steer = 0;
    this.isBraking = false;
    this.isNitro = false;
    this.drift = 0;
    this.distance = 0;
    this.lap = 1;
    this.ping = 0;
    this.lastPingTimestamp = Date.now();
    this.lastActive = Date.now();
  }
  getColor() {
    return PLAYER_COLORS[this.colorIndex];
  }
  setColor(cssOrHex) {
    if (typeof cssOrHex === "number") {
      this.colorIndex = cssOrHex % PLAYER_COLORS.length;
      return;
    }
    const idx = PLAYER_COLORS.findIndex((c) => c.css.toLowerCase() === (cssOrHex || "").toLowerCase());
    if (idx !== -1) {
      this.colorIndex = idx;
    }
  }
  toJSON() {
    const col = this.getColor();
    return {
      id: this.id,
      name: this.name,
      color: col.css,
      colorHex: col.css,
      colorIndex: this.colorIndex,
      isReady: this.isReady,
      ready: this.isReady,
      isHost: this.isHost,
      gridPosition: this.gridPosition,
      ping: this.ping,
      pos: this.pos,
      position: this.pos,
      rot: this.rot,
      rotationY: this.rot,
      speed: this.speed,
      steer: this.steer,
      steerAngle: this.steer,
      isBraking: this.isBraking,
      isNitro: this.isNitro,
      isDrifting: this.drift > 0.1,
      drift: this.drift,
      distance: this.distance,
      lap: this.lap
    };
  }
};

// server/rooms.js
var Room = class {
  constructor(code, hostPlayer) {
    this.code = code;
    this.hostId = hostPlayer.id;
    this.players = /* @__PURE__ */ new Map();
    this.state = "LOBBY";
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.chatHistory = [];
    this.maxPlayers = 8;
    this.levelId = "LEVEL_1";
    this.addPlayer(hostPlayer, true);
  }
  addPlayer(player, isHost = false) {
    if (this.players.size >= this.maxPlayers) {
      return false;
    }
    player.roomCode = this.code;
    player.isHost = isHost;
    player.isReady = isHost;
    player.gridPosition = this.players.size;
    player.colorIndex = this.players.size % 8;
    this.players.set(player.id, player);
    this.lastActivity = Date.now();
    return true;
  }
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;
    player.roomCode = null;
    player.isHost = false;
    this.players.delete(playerId);
    this.lastActivity = Date.now();
    let idx = 0;
    for (const p of this.players.values()) {
      p.gridPosition = idx++;
    }
    if (this.hostId === playerId && this.players.size > 0) {
      const nextHost = Array.from(this.players.values())[0];
      nextHost.isHost = true;
      nextHost.isReady = true;
      this.hostId = nextHost.id;
    }
    return player;
  }
  isEmpty() {
    return this.players.size === 0;
  }
  isAllReady() {
    if (this.players.size < 1) return false;
    for (const player of this.players.values()) {
      if (!player.isReady && !player.isHost) return false;
    }
    return true;
  }
  broadcast(message, excludePlayerId = null) {
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    for (const player of this.players.values()) {
      if (excludePlayerId && player.id === excludePlayerId) continue;
      if (player.ws && player.ws.readyState === 1) {
        try {
          player.ws.send(raw);
        } catch (e) {
        }
      }
    }
  }
  getPlayersData() {
    return Array.from(this.players.values()).map((p) => p.toJSON());
  }
  toJSON() {
    return {
      code: this.code,
      roomCode: this.code,
      hostId: this.hostId,
      state: this.state,
      levelId: this.levelId,
      playersCount: this.players.size,
      maxPlayers: this.maxPlayers,
      players: this.getPlayersData()
    };
  }
};
var RoomManager = class {
  constructor() {
    this.rooms = /* @__PURE__ */ new Map();
  }
  generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    let attempts = 0;
    do {
      code = "";
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      attempts++;
    } while (this.rooms.has(code) && attempts < 100);
    return code;
  }
  createRoom(hostPlayer) {
    const code = this.generateRoomCode();
    const room = new Room(code, hostPlayer);
    this.rooms.set(code, room);
    return room;
  }
  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.toUpperCase().trim()) || null;
  }
  cleanupInactiveRooms(maxInactiveMs = 15 * 60 * 1e3) {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.isEmpty() || now - room.lastActivity > maxInactiveMs) {
        this.rooms.delete(code);
      }
    }
  }
  getPublicRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.state === "LOBBY" && room.players.size < room.maxPlayers) {
        const hostPlayer = room.players.get(room.hostId);
        list.push({
          code: room.code,
          playersCount: room.players.size,
          maxPlayers: room.maxPlayers,
          levelId: room.levelId,
          hostName: hostPlayer ? hostPlayer.name : "Host"
        });
      }
    }
    return list;
  }
};

// server/gameLoop.js
var GameLoop = class {
  constructor(roomManager2, tickRate = 25) {
    this.roomManager = roomManager2;
    this.tickRate = tickRate;
    this.intervalMs = Math.round(1e3 / tickRate);
    this.timer = null;
    this.pingTimer = null;
    this.cleanupTimer = null;
  }
  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.pingTimer = setInterval(() => this.checkPings(), 2500);
    this.cleanupTimer = setInterval(() => {
      this.roomManager.cleanupInactiveRooms();
    }, 3e4);
    console.log(`[GameLoop] Started authoritative sync loop at ${this.tickRate} Hz (${this.intervalMs} ms)`);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
  tick() {
    const timestamp = Date.now();
    for (const room of this.roomManager.rooms.values()) {
      if (room.state !== "RACING" || room.players.size === 0) continue;
      const playersData = [];
      for (const p of room.players.values()) {
        playersData.push({
          id: p.id,
          name: p.name,
          color: p.getColor().css,
          pos: p.pos,
          position: p.pos,
          rot: p.rot,
          rotationY: p.rot,
          speed: p.speed,
          steer: p.steer,
          steerAngle: p.steer,
          isBraking: p.isBraking,
          isNitro: p.isNitro,
          isDrifting: p.drift > 0.1,
          drift: p.drift,
          distance: p.distance,
          lap: p.lap || 1,
          ping: p.ping
        });
      }
      room.broadcast({
        type: "world-state",
        data: {
          timestamp,
          players: playersData
        },
        players: playersData
        // backward-compatible top-level
      });
    }
  }
  checkPings() {
    const now = Date.now();
    for (const room of this.roomManager.rooms.values()) {
      for (const player of room.players.values()) {
        if (player.ws && player.ws.readyState === 1) {
          player.lastPingTimestamp = now;
          try {
            player.ws.send(JSON.stringify({ type: "ping", data: { clientTime: now } }));
          } catch (e) {
          }
        }
      }
    }
  }
};

// server/index.js
var PORT = process.env.PORT || 3001;
var server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: Date.now() }));
    return;
  }
  if (url.pathname.startsWith("/join/")) {
    const code = url.pathname.split("/")[2];
    const clientUrl = `http://localhost:5173/?room=${encodeURIComponent(code)}`;
    res.writeHead(302, { Location: clientUrl });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Velocity Rush Multiplayer Server Running");
});
var wss = new WebSocketServer({ server });
var roomManager = new RoomManager();
var gameLoop = new GameLoop(roomManager, 25);
gameLoop.start();
var nextPlayerId = 1e3;
wss.on("connection", (ws, req) => {
  const playerId = `p_${nextPlayerId++}`;
  let player = new Player(playerId, ws, `Racer #${playerId.slice(-3)}`);
  console.log(`[WS] Player connected: ${playerId}`);
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleClientMessage(ws, player, msg);
    } catch (err) {
      console.error("[WS Error] Bad JSON:", err.message);
    }
  });
  ws.on("close", () => {
    console.log(`[WS] Player disconnected: ${player.id}`);
    handlePlayerDisconnect(player);
  });
  ws.on("error", (err) => {
    console.error(`[WS Error] ${player.id}:`, err.message);
  });
  ws.send(JSON.stringify({
    type: "connected",
    data: {
      playerId: player.id,
      playerName: player.name
    }
  }));
});
function handleClientMessage(ws, player, msg) {
  const payload = msg.data !== void 0 ? msg.data : msg;
  switch (msg.type) {
    case "set-name": {
      const name = payload.name || payload.playerName;
      if (typeof name === "string" && name.trim().length > 0) {
        player.name = name.trim().slice(0, 16);
        const room = roomManager.getRoom(player.roomCode);
        if (room) {
          room.broadcast({
            type: "room-update",
            data: room.toJSON()
          });
        }
      }
      break;
    }
    case "get-rooms": {
      ws.send(JSON.stringify({
        type: "room-list",
        data: {
          rooms: roomManager.getPublicRooms()
        }
      }));
      break;
    }
    case "create-room": {
      if (player.roomCode) {
        const oldRoom = roomManager.getRoom(player.roomCode);
        if (oldRoom) oldRoom.removePlayer(player.id);
      }
      const name = payload.name || payload.playerName;
      if (name && typeof name === "string") {
        player.name = name.trim().slice(0, 16);
      }
      if (payload.color) {
        player.setColor(payload.color);
      }
      const room = roomManager.createRoom(player);
      console.log(`[Room] Created ${room.code} by ${player.name} (${player.id})`);
      const roomData = room.toJSON();
      ws.send(JSON.stringify({
        type: "room-created",
        data: {
          roomCode: room.code,
          playerId: player.id,
          isHost: true,
          room: roomData
        }
      }));
      break;
    }
    case "join-room": {
      const code = (payload.roomCode || payload.code || "").toUpperCase().trim();
      const room = roomManager.getRoom(code);
      if (!room) {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "ROOM_NOT_FOUND",
            message: `Room "${code}" not found. Please check the code.`
          }
        }));
        return;
      }
      if (room.state === "RACING") {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "MATCH_IN_PROGRESS",
            message: `Room "${code}" has already started racing.`
          }
        }));
        return;
      }
      if (room.players.size >= room.maxPlayers) {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "ROOM_FULL",
            message: `Room "${code}" is full (maximum 8 players).`
          }
        }));
        return;
      }
      const name = payload.name || payload.playerName;
      if (name && typeof name === "string") {
        player.name = name.trim().slice(0, 16);
      }
      if (payload.color) {
        player.setColor(payload.color);
      }
      const added = room.addPlayer(player, false);
      if (!added) {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "JOIN_FAILED",
            message: "Failed to join room."
          }
        }));
        return;
      }
      console.log(`[Room] ${player.name} joined ${room.code}`);
      const roomData = room.toJSON();
      ws.send(JSON.stringify({
        type: "room-joined",
        data: {
          roomCode: room.code,
          playerId: player.id,
          isHost: false,
          room: roomData
        }
      }));
      room.broadcast({
        type: "player-joined",
        data: {
          player: player.toJSON(),
          room: roomData
        }
      });
      room.broadcast({
        type: "chat-notice",
        data: {
          text: `${player.name} joined the lobby`
        }
      });
      break;
    }
    case "toggle-ready": {
      const room = roomManager.getRoom(player.roomCode);
      if (!room || room.state !== "LOBBY") return;
      player.isReady = !player.isReady;
      room.broadcast({
        type: "room-update",
        data: room.toJSON()
      });
      break;
    }
    case "select-color": {
      const room = roomManager.getRoom(player.roomCode);
      if (!room || room.state !== "LOBBY") return;
      if (payload.color) {
        player.setColor(payload.color);
      } else if (typeof payload.colorIndex === "number") {
        player.setColor(payload.colorIndex);
      }
      room.broadcast({
        type: "room-update",
        data: room.toJSON()
      });
      break;
    }
    case "start-game": {
      const room = roomManager.getRoom(player.roomCode);
      if (!room || room.state !== "LOBBY") return;
      if (room.hostId !== player.id) {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "NOT_HOST",
            message: "Only the host can start the match."
          }
        }));
        return;
      }
      if (!room.isAllReady()) {
        ws.send(JSON.stringify({
          type: "error",
          data: {
            code: "NOT_ALL_READY",
            message: "Waiting for all racers to ready up before starting!"
          }
        }));
        return;
      }
      room.state = "RACING";
      console.log(`[Room] Match started in ${room.code} with ${room.players.size} racers!`);
      room.broadcast({
        type: "game-start",
        data: {
          roomCode: room.code,
          laps: 3,
          startTime: Date.now() + 3e3,
          players: room.getPlayersData()
        }
      });
      break;
    }
    case "player-update": {
      const room = roomManager.getRoom(player.roomCode);
      if (!room) return;
      if (payload.position) {
        player.pos = payload.position;
      } else if (payload.pos) {
        player.pos = payload.pos;
      }
      if (payload.rotationY !== void 0) {
        player.rot = payload.rotationY;
      } else if (payload.rot !== void 0) {
        player.rot = payload.rot;
      }
      if (payload.speed !== void 0) player.speed = payload.speed;
      if (payload.steerAngle !== void 0) player.steer = payload.steerAngle;
      else if (payload.steer !== void 0) player.steer = payload.steer;
      if (payload.isBraking !== void 0) player.isBraking = !!payload.isBraking;
      if (payload.isNitro !== void 0) player.isNitro = !!payload.isNitro;
      if (payload.isDrifting !== void 0) player.drift = payload.isDrifting ? 1 : 0;
      else if (payload.drift !== void 0) player.drift = payload.drift;
      if (payload.distance !== void 0) player.distance = payload.distance;
      if (payload.lap !== void 0) player.lap = payload.lap;
      player.lastActive = Date.now();
      break;
    }
    case "chat-message": {
      const room = roomManager.getRoom(player.roomCode);
      if (!room) return;
      const text = (payload.text || "").trim();
      if (!text || text.length > 120) return;
      const chatPacket = {
        type: "chat-message",
        data: {
          senderId: player.id,
          senderName: player.name,
          color: player.getColor().css,
          text,
          timestamp: Date.now()
        }
      };
      room.chatHistory.push(chatPacket.data);
      if (room.chatHistory.length > 50) room.chatHistory.shift();
      room.broadcast(chatPacket);
      break;
    }
    case "leave-room": {
      handlePlayerLeaveRoom(player);
      break;
    }
    case "ping": {
      ws.send(JSON.stringify({
        type: "pong",
        data: { clientTime: payload.clientTime || Date.now() }
      }));
      break;
    }
    case "pong": {
      player.ping = Math.max(1, Date.now() - (player.lastPingTimestamp || Date.now()));
      break;
    }
    default:
      console.warn(`[WS] Unknown packet type: ${msg.type}`);
  }
}
function handlePlayerLeaveRoom(player) {
  if (!player.roomCode) return;
  const room = roomManager.getRoom(player.roomCode);
  if (!room) return;
  const roomCode = room.code;
  room.removePlayer(player.id);
  console.log(`[Room] ${player.name} left ${roomCode}`);
  if (room.isEmpty()) {
    roomManager.rooms.delete(roomCode);
    console.log(`[Room] Deleted empty room ${roomCode}`);
  } else {
    room.broadcast({
      type: "player-left",
      data: {
        playerId: player.id,
        name: player.name,
        newHostId: room.hostId,
        room: room.toJSON()
      }
    });
    room.broadcast({
      type: "chat-notice",
      data: {
        text: `${player.name} left the race`
      }
    });
  }
}
function handlePlayerDisconnect(player) {
  handlePlayerLeaveRoom(player);
}
server.listen(PORT, () => {
  console.log("=============================================");
  console.log("\u{1F680} Velocity Rush Multiplayer Server Active!");
  console.log(`\u{1F4E1} WebSocket Port: ${PORT}`);
  console.log(`\u{1F517} Health Check:   http://localhost:${PORT}/health`);
  console.log("=============================================");
});
