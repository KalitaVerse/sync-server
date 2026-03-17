"use strict";
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms: Map<roomCode, { members: Set<WebSocket>, state: Object|null }>
const rooms = new Map();

// ── Heartbeat ─────────────────────────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[heartbeat] terminating dead connection");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

// ── Helpers ───────────────────────────────────────────────────────────

function cleanup(roomCode, ws) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return;

  roomData.members.delete(ws);

  if (roomData.members.size === 0) {
    rooms.delete(roomCode);
    console.log(`[room ${roomCode}] empty, removed`);
  }
}

function broadcast(roomCode, senderWs, message) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return;

  for (const client of roomData.members) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(message);
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

    if (data.type === "ping") return;

    const { type, room } = data;

    switch (type) {
      case "join": {
        if (!room || typeof room !== "string" || !/^\d{6}$/.test(room)) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Invalid room code (must be 6 digits)",
          }));
          return;
        }

        if (joinedRoom) {
          cleanup(joinedRoom, ws);
          const oldRoom = rooms.get(joinedRoom);
          broadcast(joinedRoom, ws, JSON.stringify({
            type: "member_left",
            members: oldRoom ? oldRoom.members.size : 0,
          }));
        }

        if (!rooms.has(room)) {
          rooms.set(room, { members: new Set(), state: null });
        }

        const roomData = rooms.get(room);
        roomData.members.add(ws);
        joinedRoom = room;

        const count = roomData.members.size;
        console.log(`[room ${room}] joined (${count} in room)`);

        // Confirm join
        ws.send(JSON.stringify({ type: "joined", room, members: count }));

        // 🔥 SEND CURRENT STATE (CRITICAL FIX)
        if (roomData.state) {
          ws.send(JSON.stringify(roomData.state));
        }

        broadcast(room, ws, JSON.stringify({
          type: "member_joined",
          members: count,
        }));
        break;
      }

      case "sync_full":
      case "play":
      case "pause":
      case "resume":
      case "seek": {
        if (!joinedRoom) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Not in a room",
          }));
          return;
        }

        const currentRoom = rooms.get(joinedRoom);

        if (currentRoom) {
          if (type === "sync_full" || type === "play") {
            // 🔥 STORE FULL STATE WITH CORRECT TIME
            currentRoom.state = {
              ...data,
              serverTime: Date.now(),
            };
          } else if (currentRoom.state) {
            // 🔥 UPDATE EXISTING STATE
            currentRoom.state = {
              ...currentRoom.state,
              ...data,
              serverTime: Date.now(),
            };
          }
        }

        broadcast(joinedRoom, ws, JSON.stringify(data));
        break;
      }

      default:
        ws.send(JSON.stringify({
          type: "error",
          message: `Unknown type: ${type}`,
        }));
    }
  });

  ws.on("close", () => {
    if (!joinedRoom) return;
    cleanup(joinedRoom, ws);

    const roomData = rooms.get(joinedRoom);
    broadcast(joinedRoom, ws, JSON.stringify({
      type: "member_left",
      members: roomData ? roomData.members.size : 0,
    }));

    console.log(`[room ${joinedRoom}] client disconnected`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    if (joinedRoom) cleanup(joinedRoom, ws);
  });
});

console.log(`Sync server running on port: ${PORT}`);

// ── Periodic status log ───────────────────────────────────────────────
setInterval(() => {
  if (rooms.size > 0) {
    console.log(`[status] ${rooms.size} active room(s):`);
    for (const [code, data] of rooms) {
      console.log(`  room ${code}: ${data.members.size} member(s)`);
    }
  }
}, 30000);