const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// =======================
// Persistencia simple (JSON)
// =======================

// Si en Render activás "Disk", poné env DATA_DIR=/var/data
// Si no, usa la carpeta del proyecto (puede resetearse en Free)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, "data.json");

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      requestsByTo: parsed.requestsByTo || {},
      contactsByAlias: parsed.contactsByAlias || {},
    };
  } catch {
    return { requestsByTo: {}, contactsByAlias: {} };
  }
}

function saveDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.log("⚠️ No pude guardar DB:", e.message);
  }
}

const db = loadDB();

// =======================
// Runtime state
// =======================

// alias => Set<WebSocket>
const aliasSockets = new Map();

// rooms: roomId => Set<WebSocket>
const rooms = new Map();

// =======================
// Helpers
// =======================

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

function ensureContacts(alias) {
  if (!db.contactsByAlias[alias]) db.contactsByAlias[alias] = [];
}

function addContactBoth(a, b) {
  ensureContacts(a);
  ensureContacts(b);

  if (!db.contactsByAlias[a].includes(b)) db.contactsByAlias[a].push(b);
  if (!db.contactsByAlias[b].includes(a)) db.contactsByAlias[b].push(a);

  saveDB();
}

function removeContactBoth(a, b) {
  ensureContacts(a);
  ensureContacts(b);

  db.contactsByAlias[a] = db.contactsByAlias[a].filter((x) => x !== b);
  db.contactsByAlias[b] = db.contactsByAlias[b].filter((x) => x !== a);

  saveDB();
}

function getPendingRequestsFor(alias) {
  return db.requestsByTo[alias] || [];
}

function addRequest(to, from, requestId) {
  if (!db.requestsByTo[to]) db.requestsByTo[to] = [];

  // Evitar duplicados por (from) si ya hay pendiente de ese alias
  const exists = db.requestsByTo[to].some((r) => r.from === from && r.status === "pending");
  if (exists) return null;

  const req = {
    id: requestId,
    to,
    from,
    status: "pending", // pending | accepted | rejected
    createdAt: Date.now(),
  };

  db.requestsByTo[to].unshift(req);
  saveDB();
  return req;
}

function markRequest(to, requestId, status) {
  const list = db.requestsByTo[to] || [];
  const idx = list.findIndex((r) => r.id === requestId);
  if (idx === -1) return null;
  list[idx].status = status;
  list[idx].updatedAt = Date.now();
  saveDB();
  return list[idx];
}

function removeRequest(to, requestId) {
  const list = db.requestsByTo[to] || [];
  db.requestsByTo[to] = list.filter((r) => r.id !== requestId);
  saveDB();
}

// ✅ NUEVO: limpiar solicitudes pending entre dos aliases (en ambos sentidos)
// Esto evita el “duplicate_pending” eterno luego del tacho.
function clearPendingBetween(a, b) {
  if (!a || !b) return;

  // a recibió de b
  if (db.requestsByTo[a]) {
    const before = db.requestsByTo[a].length;
    db.requestsByTo[a] = db.requestsByTo[a].filter(
      (r) => !(r.status === "pending" && r.from === b)
    );
    const after = db.requestsByTo[a].length;
    if (before !== after) console.log("CLEAR_PENDING_DB", b, "->", a, "removed:", before - after);
  }

  // b recibió de a
  if (db.requestsByTo[b]) {
    const before = db.requestsByTo[b].length;
    db.requestsByTo[b] = db.requestsByTo[b].filter(
      (r) => !(r.status === "pending" && r.from === a)
    );
    const after = db.requestsByTo[b].length;
    if (before !== after) console.log("CLEAR_PENDING_DB", a, "->", b, "removed:", before - after);
  }

  saveDB();
}

// RoomId determinístico para 1-1
function roomIdFor(a, b) {
  return [a, b].sort().join("_");
}

// =======================
// WebSocket server
// =======================

wss.on("connection", (ws) => {
  ws.alias = null;
  ws.currentRoom = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // =======================
    // REGISTER
    // =======================
    if (data.type === "register" && typeof data.alias === "string") {
      const alias = data.alias.trim();
      if (!alias) return;

      ws.alias = alias;
      addAliasSocket(alias, ws);

      ensureContacts(alias);

      // Enviar snapshot al conectar: contactos + requests pendientes
      const pending = getPendingRequestsFor(alias).filter((r) => r.status === "pending");

      safeSend(ws, {
        type: "bootstrap",
        alias,
        contacts: db.contactsByAlias[alias] || [],
        pendingRequests: pending,
      });

      console.log("REGISTER", alias, "tabs:", aliasSockets.get(alias).size);
      return;
    }

    // si no registró, ignoramos cosas sensibles
    if (!ws.alias) return;

    // =======================
    // REQUEST_SEND
    // =======================
    if (data.type === "request_send") {
      const to = typeof data.to === "string" ? data.to.trim() : "";
      const from = ws.alias;
      const requestId =
        typeof data.requestId === "string" ? data.requestId : `${Date.now()}_${Math.random()}`;

      if (!to || !from || to === from) {
        safeSend(ws, { type: "request_sent", ok: false, reason: "bad_request" });
        return;
      }

      // si ya son contactos, no mandamos solicitud
      ensureContacts(from);
      if (db.contactsByAlias[from].includes(to)) {
        safeSend(ws, { type: "request_sent", ok: false, reason: "already_contacts" });
        return;
      }

      const req = addRequest(to, from, requestId);

      // Respondemos ok “genérico” (privacidad)
      safeSend(ws, { type: "request_sent", ok: true, requestId });

      if (req) {
        // si el receptor está online, se la empujamos
        sendToAlias(to, { type: "request_received", request: req });
        console.log("REQUEST", from, "->", to, "stored");
      } else {
        console.log("REQUEST", from, "->", to, "duplicate_pending");
      }
      return;
    }

    // =======================
    // REQUEST_ACCEPT
    // =======================
    if (data.type === "request_accept") {
      const requestId = typeof data.requestId === "string" ? data.requestId : "";
      if (!requestId) return;

      // el que acepta es ws.alias, por lo tanto "to" = ws.alias
      const to = ws.alias;
      const list = db.requestsByTo[to] || [];
      const req = list.find((r) => r.id === requestId);

      if (!req || req.status !== "pending") {
        safeSend(ws, { type: "request_accept_ok", ok: false });
        return;
      }

      // marcar accepted + crear contacto en ambos
      markRequest(to, requestId, "accepted");
      addContactBoth(req.from, req.to);

      // sacar de pendientes (limpieza)
      removeRequest(to, requestId);

      // ✅ limpiar cualquier pending entre ambos (por si existía algo cruzado)
      clearPendingBetween(req.from, req.to);

      // Notificar a ambos: contacto agregado + abrir chat
      const a = req.from;
      const b = req.to;

      sendToAlias(a, { type: "contact_added", with: b });
      sendToAlias(b, { type: "contact_added", with: a });

      // Abrir chat en ambos (room id determinístico)
      const room = roomIdFor(a, b);
      sendToAlias(a, { type: "open_chat", with: b, room });
      sendToAlias(b, { type: "open_chat", with: a, room });

      safeSend(ws, { type: "request_accept_ok", ok: true, with: a });

      console.log("ACCEPT", b, "accepted", a, "room", room);
      return;
    }

    // =======================
    // REQUEST_REJECT
    // =======================
    if (data.type === "request_reject") {
      const requestId = typeof data.requestId === "string" ? data.requestId : "";
      if (!requestId) return;

      const to = ws.alias;
      const list = db.requestsByTo[to] || [];
      const req = list.find((r) => r.id === requestId);

      if (!req || req.status !== "pending") {
        safeSend(ws, { type: "request_reject_ok", ok: false });
        return;
      }

      markRequest(to, requestId, "rejected");
      removeRequest(to, requestId);

      // ✅ limpiar pending entre ambos
      clearPendingBetween(req.from, req.to);

      // Notificamos al emisor (sin revelar nada extra)
      sendToAlias(req.from, { type: "request_rejected", by: to });

      safeSend(ws, { type: "request_reject_ok", ok: true });
      console.log("REJECT", to, "rejected", req.from);
      return;
    }

    // =======================
    // CONTACT_DELETE (tacho)
    // =======================
    if (data.type === "contact_delete") {
      const other = typeof data.with === "string" ? data.with.trim() : "";
      const me = ws.alias;
      if (!other) return;

      // ✅ 1) borrar el contacto de ambos
      removeContactBoth(me, other);

      // ✅ 2) borrar cualquier solicitud pendiente entre ambos (en ambos sentidos)
      clearPendingBetween(me, other);

      // ✅ 3) notificar a ambos para que lo saquen
      sendToAlias(me, { type: "contact_removed", with: other });
      sendToAlias(other, { type: "contact_removed", with: me });

      safeSend(ws, { type: "contact_delete_ok", ok: true });

      console.log("DELETE_CONTACT", me, "<->", other);
      return;
    }

    // =======================
    // JOIN ROOM
    // =======================
    if (data.type === "join" && typeof data.room === "string") {
      if (ws.currentRoom && rooms.has(ws.currentRoom)) {
        rooms.get(ws.currentRoom).delete(ws);
      }
      ws.currentRoom = data.room;

      if (!rooms.has(data.room)) rooms.set(data.room, new Set());
      rooms.get(data.room).add(ws);

      console.log("JOIN", data.room, "clients:", rooms.get(data.room).size);
      return;
    }

    // =======================
    // MESSAGE / TYPING (solo en sala)
    // =======================
    if ((data.type === "message" || data.type === "typing") && ws.currentRoom) {
      const room = rooms.get(ws.currentRoom);
      if (!room) return;

      for (const client of room) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    removeAliasSocket(ws.alias, ws);

    if (ws.currentRoom && rooms.has(ws.currentRoom)) {
      const room = rooms.get(ws.currentRoom);
      room.delete(ws);
      if (room.size === 0) rooms.delete(ws.currentRoom);
    }
  });
});

console.log(`✅ Timechat WS backend corriendo en ws://0.0.0.0:${PORT}`);
console.log(`📦 DB file: ${DB_FILE}`);
