#!/usr/bin/env node
// cb-hub — CDP multiplexer in front of the user's Chrome.
//
// Chrome's UI-toggle remote debugging (chrome://inspect/#remote-debugging)
// asks "Allow remote debugging?" for EVERY new CDP connection. cb and each
// agent-browser daemon used to open their own connections, so the user was
// asked over and over. cb-hub holds ONE upstream connection (approved once)
// and serves any number of local clients over it.
//
// Security: listens on 127.0.0.1 only; clients must know a random token that
// is part of the WebSocket path (stored in a 0600 file). Browser.close /
// Browser.crash are refused so no client can quit the user's browser. Note
// that with WSL mirrored networking, Windows-side processes of the same user
// can reach 127.0.0.1 too; the token is what keeps them out.
//
// Multiplexing (flatten mode): request ids are remapped per client; sessions
// belong to the client that attached them; browser-level events are routed by
// subscription. Target.setDiscoverTargets / Target.setAutoAttach at browser
// level are emulated per client so clients don't interfere.
//
// Usage: cb-hub.mjs <upstream ws url> <state file> [log file]   (normally started by cb)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const [UPSTREAM_URL, STATE_FILE, LOG_FILE] = process.argv.slice(2);
if (!UPSTREAM_URL || !STATE_FILE) {
  console.error("usage: cb-hub.mjs <upstream ws url> <state file> [log file]");
  process.exit(2);
}
const LOG = !!process.env.CB_HUB_LOG;
const log = (...a) => {
  const line = [new Date().toISOString(), ...a].map(String).join(" ");
  if (!LOG_FILE) return console.error(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 });
  } catch {
    console.error(line);
  }
};
const TOKEN = randomBytes(24).toString("hex");
const BLOCKED_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

// ------------------------------------------------------------------ upstream

let up;
let upId = 0;
const pending = new Map(); // upId -> { client, id, method, params } | { resolve, reject }
function upSend(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++upId;
    pending.set(id, { resolve, reject, method, params });
    up.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// ------------------------------------------------------------------ clients

let nextClient = 0;
const clients = new Map(); // cid -> client
const owners = new Map(); // sessionId -> Set<cid>
let upDiscover = false;
let upAutoAttach = false;

function own(sessionId, cids) {
  const s = owners.get(sessionId) ?? new Set();
  for (const c of cids) {
    s.add(c);
    clients.get(c)?.sessions.add(sessionId);
  }
  owners.set(sessionId, s);
}

function deliver(cids, msg) {
  const text = typeof msg === "string" ? msg : JSON.stringify(msg);
  for (const c of cids) clients.get(c)?.send(text);
}

// Upstream needs discovery on if any client wants it, or for auto-attach emulation.
async function reconcile() {
  const wantDiscover = [...clients.values()].some((c) => c.discover || c.autoAttach);
  if (wantDiscover !== upDiscover) {
    upDiscover = wantDiscover;
    await upSend("Target.setDiscoverTargets", { discover: wantDiscover }).catch((e) => log("discover", e.message));
  }
}

const AUTO_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

// Emulated browser-level auto-attach: give the client its own flat session.
async function attachFor(client, info) {
  if (!AUTO_TYPES.has(info.type) || client.attachedTargets.has(info.targetId)) return;
  client.attachedTargets.add(info.targetId);
  try {
    const { sessionId } = await upSend("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    if (!clients.has(client.cid)) return upSend("Target.detachFromTarget", { sessionId }).catch(() => {});
    own(sessionId, [client.cid]);
    client.send(
      JSON.stringify({
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false },
      }),
    );
  } catch (e) {
    client.attachedTargets.delete(info.targetId);
    if (LOG) log(`auto-attach ${info.targetId} for c${client.cid} failed: ${e.message}`);
  }
}

async function handleClientMessage(client, text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params = {}, sessionId } = m;
  if (LOG) log(`c${client.cid} -> ${method}${sessionId ? " [s]" : ""}`);
  const reply = (body) => client.send(JSON.stringify({ id, ...body, ...(sessionId ? { sessionId } : {}) }));

  if (BLOCKED_METHODS.has(method)) return reply({ error: { code: -32000, message: `${method} is blocked by cb-hub` } });
  if (sessionId && !owners.get(sessionId)?.has(client.cid))
    return reply({ error: { code: -32001, message: `Session with given id not found.` } });

  if (!sessionId && method === "Target.setDiscoverTargets") {
    const was = client.discover;
    client.discover = !!params.discover;
    await reconcile();
    reply({ result: {} });
    if (client.discover && !was) {
      // Chrome reports existing targets when discovery is switched on; emulate that per client.
      const { targetInfos } = await upSend("Target.getTargets");
      for (const info of targetInfos) client.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: info } }));
    }
    return;
  }
  if (!sessionId && method === "Target.setAutoAttach") {
    if (params.flatten === false) return reply({ error: { code: -32000, message: "cb-hub supports flatten mode only" } });
    const was = client.autoAttach;
    client.autoAttach = !!params.autoAttach;
    await reconcile();
    reply({ result: {} });
    if (client.autoAttach && !was) {
      const { targetInfos } = await upSend("Target.getTargets");
      for (const info of targetInfos) await attachFor(client, info);
    }
    return;
  }

  const uid = ++upId;
  pending.set(uid, { client, id, method, params });
  up.send(JSON.stringify({ id: uid, method, params, ...(sessionId ? { sessionId } : {}) }));
}

function handleUpstreamMessage(text) {
  const m = JSON.parse(text);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (!p.client) return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    if (!clients.has(p.client.cid)) {
      // client left before the answer: don't leak sessions it created
      if (p.method === "Target.attachToTarget" && m.result?.sessionId)
        upSend("Target.detachFromTarget", { sessionId: m.result.sessionId }).catch(() => {});
      return;
    }
    if (!m.error && (p.method === "Target.attachToTarget" || p.method === "Target.attachToBrowserTarget") && m.result?.sessionId)
      own(m.result.sessionId, [p.client.cid]);
    if (!m.error && p.method === "Target.detachFromTarget" && p.params.sessionId) dropSession(p.params.sessionId);
    m.id = p.id;
    return p.client.send(JSON.stringify(m));
  }

  // events
  const { method, params = {}, sessionId } = m;
  if (sessionId) {
    const cids = owners.get(sessionId) ?? new Set();
    if (method === "Target.attachedToTarget" && params.sessionId) own(params.sessionId, cids); // child sessions
    if (method === "Target.detachedFromTarget" && params.sessionId) {
      deliver(cids, text);
      return dropSession(params.sessionId);
    }
    return deliver(cids, text);
  }
  if (method === "Target.detachedFromTarget") {
    deliver(owners.get(params.sessionId) ?? [], text);
    return dropSession(params.sessionId);
  }
  if (method === "Target.attachedToTarget") return; // only from our own setAutoAttach, which we never send upstream
  if (method.startsWith("Target.target")) {
    const subs = [...clients.values()].filter((c) => c.discover).map((c) => c.cid);
    deliver(subs, text);
    if (method === "Target.targetCreated") for (const c of clients.values()) if (c.autoAttach) attachFor(c, params.targetInfo);
    if (method === "Target.targetDestroyed") for (const c of clients.values()) c.attachedTargets.delete(params.targetId);
    return;
  }
  deliver(clients.keys(), text); // other browser-level events (downloads, etc.)
}

function dropSession(sessionId) {
  for (const c of owners.get(sessionId) ?? []) clients.get(c)?.sessions.delete(sessionId);
  owners.delete(sessionId);
}

function removeClient(client) {
  if (!clients.delete(client.cid)) return;
  if (LOG) log(`c${client.cid} disconnected`);
  for (const s of client.sessions) {
    const set = owners.get(s);
    if (!set) continue;
    set.delete(client.cid);
    if (!set.size) {
      owners.delete(s);
      upSend("Target.detachFromTarget", { sessionId: s }).catch(() => {});
    }
  }
  for (const [uid, p] of pending) if (p.client === client) pending.delete(uid);
  reconcile();
}

// ------------------------------------------------------------------ minimal WebSocket server (RFC 6455)

function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const client = {
    cid: ++nextClient,
    sessions: new Set(),
    attachedTargets: new Set(),
    discover: false,
    autoAttach: false,
    send: (text) => sendFrame(socket, 0x1, Buffer.from(text)),
  };
  clients.set(client.cid, client);
  if (LOG) log(`c${client.cid} connected`);

  let buf = Buffer.alloc(0);
  let parts = [];
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + len);
      if (op === 0x8) {
        sendFrame(socket, 0x8, Buffer.alloc(0));
        socket.end();
        return;
      }
      if (op === 0x9) {
        sendFrame(socket, 0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      parts.push(payload);
      if (fin) {
        const text = Buffer.concat(parts).toString("utf8");
        parts = [];
        handleClientMessage(client, text).catch((e) => log(`c${client.cid}: ${e.message}`));
      }
    }
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
}

function sendFrame(socket, op, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([head, payload]));
}

// ------------------------------------------------------------------ main

function tokenOk(path) {
  const m = /^\/devtools\/browser\/([0-9a-f]+)$/.exec(path ?? "");
  if (!m || m[1].length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
}

function shutdown(code) {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (st.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
  } catch {}
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

up = new WebSocket(UPSTREAM_URL);
up.onmessage = (e) => {
  try {
    handleUpstreamMessage(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8"));
  } catch (err) {
    log("upstream message:", err.message);
  }
};
let upOpen = false;
up.onclose = () => {
  if (!upOpen) {
    log("upstream refused before opening (permission dialog denied/dismissed/timed out, or debugging off); exiting");
    return shutdown(3);
  }
  log("upstream closed (Chrome quit or remote debugging turned off); exiting");
  shutdown(0);
};
up.onerror = () => {};
up.onopen = () => {
  upOpen = true;
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const path = new URL(req.url, "http://x").pathname;
    if (!tokenOk(path) || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wsAccept(req, socket);
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const tmp = `${STATE_FILE}.${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, url: `ws://127.0.0.1:${port}/devtools/browser/${TOKEN}`, upstream: UPSTREAM_URL }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, STATE_FILE);
    log(`cb-hub ready on 127.0.0.1:${port} (upstream ${UPSTREAM_URL})`);
  });
};
