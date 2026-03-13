"use strict";
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms: Map<roomCode, Set<WebSocket>>
const rooms = new Map();

// ── Heartbeat ─────────────────────────────────────────────────────────
// Terminates ghost connections that dropped without sending a close frame
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[heartbeat] terminating dead connection");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

// ── Helpers ───────────────────────────────────────────────────────────

function cleanup(roomCode, ws) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(roomCode);
    console.log(`[room ${roomCode}] empty, removed`);
  }
}

function broadcast(roomCode, senderWs, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      // Inject server timestamp so receivers can calculate true one-way delay
      // without relying on synced device clocks
      let stamped = message;
      try {
        const parsed = JSON.parse(message.toString());
        parsed.serverTime = Date.now();
        stamped = JSON.stringify(parsed);
      } catch (_) {}
      client.send(stamped);
    }
  }
}

// ── Connection handler ────────────────────────────────────────────────

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let joinedRoom = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { type, room } = data;

    switch (type) {
      case "join": {
        if (!room || typeof room !== "string" || !/^\d{6}$/.test(room)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid room code (must be 6 digits)" }));
          return;
        }
        // Leave previous room if already in one
        if (joinedRoom) {
          cleanup(joinedRoom, ws);
          broadcast(joinedRoom, ws, JSON.stringify({
            type: "member_left",
            members: rooms.get(joinedRoom)?.size ?? 0,
          }));
          console.log(`[room ${joinedRoom}] client left to join ${room}`);
        }
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
        joinedRoom = room;

        const count = rooms.get(room).size;
        console.log(`[room ${room}] joined (${count} in room)`);

        ws.send(JSON.stringify({ type: "joined", room, members: count }));
        broadcast(room, ws, JSON.stringify({ type: "member_joined", members: count }));
        break;
      }

      case "play":
      case "pause":
      case "resume":
      case "seek": {
        if (!joinedRoom) {
          ws.send(JSON.stringify({ type: "error", message: "Not in a room" }));
          return;
        }
        broadcast(joinedRoom, ws, JSON.stringify(data));
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${type}` }));
    }
  });

  ws.on("close", () => {
    if (!joinedRoom) return;
    cleanup(joinedRoom, ws);
    broadcast(joinedRoom, ws, JSON.stringify({
      type: "member_left",
      members: rooms.get(joinedRoom)?.size ?? 0,
    }));
    console.log(`[room ${joinedRoom}] client disconnected`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    if (joinedRoom) cleanup(joinedRoom, ws);
  });
});

console.log(`Sync server running on ws://localhost:${PORT}`);

// ── Periodic status log ───────────────────────────────────────────────
setInterval(() => {
  if (rooms.size > 0) {
    console.log(`[status] ${rooms.size} active room(s):`);
    for (const [code, members] of rooms) {
      console.log(`  room ${code}: ${members.size} member(s)`);
    }
  }
}, 30_000);