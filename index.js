const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// roomId => Set<WebSocket>
const rooms = new Map();

// alias => Set<WebSocket> (permite múltiples tabs/dispositivos con mismo alias)
const aliasSockets = new Map();

// helpers
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function addAliasSocket(alias, ws) {
  if (!aliasSockets.has(alias)) aliasSockets.set(alias, new Set());
  aliasSockets.get(alias).add(ws);
}

function removeAliasSocket(alias, ws) {
  if (!alias) return;
  const set = aliasSockets.get(alias);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) aliasSockets.delete(alias);
}

function sendToAlias(alias, obj) {
  const set = aliasSockets.get(alias);
  if (!set) return false;
  for (const ws of set) safeSend(ws, obj);
  return true;
}

wss.on("connection", (ws) => {
  ws.currentRoom = null;
  ws.alias = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ───────── REGISTER (alias) ─────────
    // Cliente manda: { type:"register", alias:"abcd_1234" }
    if (data.type === "register" && typeof data.alias === "string") {
      const alias = data.alias.trim();
      if (!alias) return;

      // set alias en socket
      ws.alias = alias;
      addAliasSocket(alias, ws);

      console.log("REGISTER", alias, "conns:", aliasSockets.get(alias).size);

      // ack al cliente
      safeSend(ws, { type: "registered", alias });

      return;
    }

    // ───────── JOIN ROOM ─────────
    if (data.type === "join" && typeof data.room === "string") {
      // salir de sala anterior
      if (ws.currentRoom && rooms.has(ws.currentRoom)) {
        rooms.get(ws.currentRoom).delete(ws);
      }

      ws.currentRoom = data.room;

      if (!rooms.has(data.room)) {
        rooms.set(data.room, new Set());
      }

      rooms.get(data.room).add(ws);

      console.log("JOIN", data.room, "clientes:", rooms.get(data.room).size);
      return;
    }

    // ───────── REQUESTS (solicitudes) ─────────
    // Enviar solicitud:
    // { type:"request_send", to:"aliasDestino", from:"aliasOrigen", requestId:"..." }
    if (data.type === "request_send") {
      const to = typeof data.to === "string" ? data.to.trim() : "";
      const from = typeof data.from === "string" ? data.from.trim() : ws.alias;
      const requestId =
        typeof data.requestId === "string" ? data.requestId : `${Date.now()}_${Math.random()}`;

      if (!to || !from) return;

      const delivered = sendToAlias(to, {
        type: "request_received",
        request: {
          id: requestId,
          alias: from,
          timestamp: Date.now(),
        },
      });

      // No avisamos si existe o no (tu regla de privacidad),
      // pero sí podemos devolver un "ok" genérico al emisor:
      safeSend(ws, {
        type: "request_sent",
        to,
        requestId,
        delivered: !!delivered, // si querés ocultarlo, podés borrar este campo en frontend
      });

      console.log("REQUEST", from, "->", to, delivered ? "DELIVERED" : "OFFLINE");
      return;
    }

    // Aceptar solicitud:
    // { type:"request_accept", to:"aliasOrigen", from:"miAlias", requestId:"..." }
    if (data.type === "request_accept") {
      const to = typeof data.to === "string" ? data.to.trim() : "";
      const from = typeof data.from === "string" ? data.from.trim() : ws.alias;
      const requestId = typeof data.requestId === "string" ? data.requestId : "";

      if (!to || !from) return;

      sendToAlias(to, {
        type: "request_accepted",
        by: from,
        requestId,
      });

      safeSend(ws, { type: "request_accept_ok", requestId });

      console.log("ACCEPT", from, "accepted", to);
      return;
    }

    // Rechazar solicitud:
    // { type:"request_reject", to:"aliasOrigen", from:"miAlias", requestId:"..." }
    if (data.type === "request_reject") {
      const to = typeof data.to === "string" ? data.to.trim() : "";
      const from = typeof data.from === "string" ? data.from.trim() : ws.alias;
      const requestId = typeof data.requestId === "string" ? data.requestId : "";

      if (!to || !from) return;

      sendToAlias(to, {
        type: "request_rejected",
        by: from,
        requestId,
      });

      safeSend(ws, { type: "request_reject_ok", requestId });

      console.log("REJECT", from, "rejected", to);
      return;
    }

    // ───── MESSAGE / TYPING / LEFT (ROOM) ─────
    if (
      (data.type === "message" || data.type === "typing" || data.type === "left") &&
      ws.currentRoom
    ) {
      const room = rooms.get(ws.currentRoom);
      if (!room) return;

      if (data.type === "message") {
        console.log("MSG", ws.currentRoom, data.payload?.from, data.payload?.body);
      }

      // reenviar a todos MENOS al emisor
      for (const client of room) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      }
      return;
    }
  });

  // ───────── CLOSE ─────────
  ws.on("close", () => {
    // quitar de alias registry
    removeAliasSocket(ws.alias, ws);

    // quitar de room
    if (ws.currentRoom && rooms.has(ws.currentRoom)) {
      const room = rooms.get(ws.currentRoom);
      room.delete(ws);

      if (room.size === 0) {
        rooms.delete(ws.currentRoom);
      }
    }
  });
});

console.log(`✅ Timechat WS backend corriendo en ws://0.0.0.0:${PORT}`);
