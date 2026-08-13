/**
 * term — real PTY backend (MODE 2).
 *
 * A standalone Node.js WebSocket server that spawns a real Linux shell via
 * node-pty. Deploy it on a VPS/Docker/Fly.io/Render — NOT on Vercel, whose
 * serverless functions cannot host interactive PTYs.
 *
 * Env:
 *   TERMINAL_AUTH_TOKEN   (required in production) token the browser sends
 *   TERMINAL_SHELL        shell binary to spawn        (default /bin/bash)
 *   TERMINAL_CWD          working directory            (default /home/term)
 *   PORT                  listen port                  (default 8080)
 *   MAX_CLIENTS           concurrent sessions cap      (default 8)
 *   MAX_PER_IP            concurrent sessions per IP   (default 2)
 *   IDLE_TIMEOUT_MS       close idle sessions (0=off)  (default 0)
 *
 * Wire protocol (JSON over WebSocket at /ws):
 *   client → { type: "auth", token, cols?, rows? }
 *   server → { type: "ready", cols, rows }
 *   client → { type: "input", data }
 *   client → { type: "resize", cols, rows }
 *   server → { type: "data", data }
 *   server → { type: "exit", exitCode }
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.TERMINAL_AUTH_TOKEN || "";
const SHELL = process.env.TERMINAL_SHELL || "/bin/bash";
const CWD = process.env.TERMINAL_CWD || "/home/term";
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS || 8);
const MAX_PER_IP = Number(process.env.MAX_PER_IP || 2);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 0);
const MSG_RATE_LIMIT = 120; // messages per 10s window

if (!AUTH_TOKEN) {
  console.warn("[term-pty] WARNING: TERMINAL_AUTH_TOKEN is not set — anyone can connect!");
}

function tokensEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const log = (...args) => console.log(new Date().toISOString(), "[term-pty]", ...args);

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), shell: SHELL }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found. The WebSocket endpoint is /ws");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const perIp = new Map(); // ip -> { sockets: Set, count }
let totalClients = 0;

function track(ip) {
  if (!perIp.has(ip)) perIp.set(ip, { sockets: new Set(), count: 0 });
  const entry = perIp.get(ip);
  entry.count += 1;
  return entry;
}

function untrack(ip, socket) {
  const entry = perIp.get(ip);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  entry.sockets.delete(socket);
  if (entry.count === 0) perIp.delete(ip);
}

wss.on("connection", (socket, request) => {
  const ip = request.socket.remoteAddress || "unknown";
  const entry = track(ip);

  if (totalClients >= MAX_CLIENTS) {
    untrack(ip, socket);
    socket.close(1013, "server full");
    return;
  }
  if (entry.count > MAX_PER_IP) {
    untrack(ip, socket);
    socket.close(1013, "too many connections from this address");
    return;
  }

  let authed = false;
  let proc = null;
  let idleTimer = null;
  let closed = false;
  let msgWindow = { count: 0, start: Date.now() };

  const resetIdle = () => {
    if (!IDLE_TIMEOUT_MS) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`[${ip}] idle timeout, closing`);
      socket.close(4000, "idle timeout");
    }, IDLE_TIMEOUT_MS);
  };

  const shutdown = (code, reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      proc = null;
    }
    if (authed) {
      totalClients = Math.max(0, totalClients - 1);
      untrack(ip, socket);
    }
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  socket.on("message", (raw) => {
    if (closed) return;

    // Simple rate limiting per socket.
    const now = Date.now();
    if (now - msgWindow.start > 10_000) msgWindow = { count: 0, start: now };
    msgWindow.count += 1;
    if (msgWindow.count > MSG_RATE_LIMIT) {
      log(`[${ip}] rate limit exceeded, closing`);
      shutdown(1008, "rate limit exceeded");
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!authed) {
      if (msg && msg.type === "auth" && AUTH_TOKEN && typeof msg.token === "string" && tokensEqual(msg.token, AUTH_TOKEN)) {
        authed = true;
        totalClients += 1;
        log(`[${ip}] authenticated, spawning ${SHELL}`);
        proc = pty.spawn(SHELL, [], {
          name: "xterm-256color",
          cols: Number.isInteger(msg.cols) ? msg.cols : 80,
          rows: Number.isInteger(msg.rows) ? msg.rows : 24,
          cwd: CWD,
          env: { ...process.env, TERM: "xterm-256color", TERMINAL_MODE: "pty", HOME: CWD },
        });
        proc.onData((data) => {
          if (!closed && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "data", data }));
          }
        });
        proc.onExit(({ exitCode }) => {
          log(`[${ip}] shell exited with code ${exitCode}`);
          if (!closed && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "exit", exitCode }));
          }
          shutdown(1000, "shell exited");
        });
        socket.send(JSON.stringify({ type: "ready", cols: proc.cols, rows: proc.rows }));
        resetIdle();
      } else {
        log(`[${ip}] authentication failed`);
        socket.close(1008, "authentication failed");
      }
      return;
    }

    switch (msg.type) {
      case "input":
        if (typeof msg.data === "string" && proc) {
          proc.write(msg.data);
          resetIdle();
        }
        break;
      case "resize":
        if (proc && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          try {
            proc.resize(msg.cols, msg.rows);
          } catch {
            /* shell already gone */
          }
        }
        break;
      default:
        break;
    }
  });

  socket.on("close", () => {
    log(`[${ip}] disconnected`);
    shutdown(1000, "closed");
  });
  socket.on("error", (error) => {
    log(`[${ip}] socket error: ${error.message}`);
    shutdown(1011, "internal error");
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${PORT} (shell: ${SHELL}, cwd: ${CWD}, max clients: ${MAX_CLIENTS})`);
});
