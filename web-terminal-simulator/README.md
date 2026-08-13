# term — web terminal

A **sandboxed web terminal** built with Next.js (App Router) + xterm.js.

It behaves like a Termux/CMD/Linux-shell-style terminal, but — honestly — it is
**not** a full Linux shell in the browser. Depending on the mode you choose, it
either runs commands in a **virtual shell** (allowlisted commands, virtual
filesystem, package registry) or streams keystrokes to a **real PTY backend**
that you deploy yourself.

> **Platform truth:** Vercel serverless functions cannot host interactive
> PTYs. No amount of code changes that. This project therefore ships two
> modes (below) and never pretends that `apt install git` on Vercel installs
> a real git binary.

---

## Modes

### MODE 1 — Serverless command runner (default, works on Vercel)

- The terminal renders with xterm.js; line editing happens client-side.
- On **Enter**, the command is POSTed to `/api/terminal/exec`.
- The API validates it (auth → rate limit → danger policy → allowlist) and
  runs it in a **virtual shell**: commands like `ls`, `cd`, `cat`, `echo`,
  `pkg install`, `apt install`, `cron`, `vercel`, `storage`, `reset` operate
  on a per-session virtual filesystem and package registry.
- Long output streams back over **Server-Sent Events** (`stream: true`).
- Commands are bounded by a timeout and an output-size limit.
- `pkg`/`apt` are a **registry/manifest** package manager: installs create
  virtual entries and `/usr/bin` stubs — they never download or execute
  binaries. The final line of every install says so explicitly.

### MODE 2 — Real PTY backend (external VPS/Docker/Fly.io/Render)

- A standalone Node.js WebSocket server (`server/pty-server/`) spawns a real
  shell via `node-pty`, with auth (`TERMINAL_AUTH_TOKEN`), per-IP connection
  caps, message rate limiting, idle timeout, and a non-root user in Docker.
- Set `NEXT_PUBLIC_TERMINAL_MODE=pty` and `NEXT_PUBLIC_PTY_WS_URL=wss://…/ws`
  and the frontend switches from the line editor to raw keystroke streaming.
- See [Deploying the PTY backend](#deploying-the-pty-backend).

---

## Quick start (local dev)

```bash
cd web-terminal-simulator
cp .env.example .env.local   # optional — everything has safe defaults
npm install                  # or: bun install
npm run dev                  # http://localhost:3000
```

Open the app, type `help`. With no env vars set, auth is disabled and storage
is in-memory — fine for development.

### Scripts

| Script                  | What it does                        |
| ----------------------- | ----------------------------------- |
| `npm run dev`           | Next dev server (binds 0.0.0.0)     |
| `npm run build`         | Production build                    |
| `npm run typecheck`     | `tsc --noEmit`                      |
| `npm run lint`          | ESLint (flat config)                |
| `npm run verify`        | typecheck + lint + build            |

---

## Environment variables

All variables are optional in development. `TERMINAL_AUTH_TOKEN` and
`CRON_SECRET` **must** be set for any production deployment.

### Authentication

| Variable              | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `TERMINAL_AUTH_TOKEN` | When set, every terminal/cron API requires `Authorization: Bearer <token>` or a session cookie from `POST /api/auth/session`. |
| `SESSION_SECRET`      | Signs the HttpOnly session cookie. Falls back to `TERMINAL_AUTH_TOKEN`.  |
| `CRON_SECRET`         | `POST /api/cron/trigger` validates `Authorization: Bearer <CRON_SECRET>`. Vercel Cron attaches this header automatically when the env var exists. |

### Mode

| Variable                    | Purpose                                                          |
| --------------------------- | --------------------------------------------------------------- |
| `NEXT_PUBLIC_TERMINAL_MODE` | `serverless` (default) or `pty`.                                |
| `NEXT_PUBLIC_PTY_WS_URL`    | WebSocket URL of the PTY backend, e.g. `wss://term-pty.example.com/ws`. |
| `NEXT_PUBLIC_PTY_WS_TOKEN`  | Token the browser sends to the PTY backend (dev convenience).   |

### Storage

Storage is behind an adapter interface (`lib/storage/`) with four backends.
Without any credentials the app falls back to **in-memory** storage (ephemeral
— state can be lost between serverless invocations).

| Variable              | Adapter                    | Active when                          |
| --------------------- | -------------------------- | ------------------------------------ |
| `STORAGE_DRIVER`      | override: `memory` \| `vercel-kv` \| `vercel-blob` \| `postgres` | always (optional) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Vercel KV (preferred) | present |
| `POSTGRES_URL`        | Vercel Postgres            | present                              |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (coarse snapshots only) | present                      |

> Vercel Blob is object storage, not a KV store — the Blob adapter is
> implemented for completeness and coarse data; prefer KV or Postgres for
> session state and cron jobs.

### Limits & identity

| Variable               | Default | Purpose                                   |
| ---------------------- | ------- | ----------------------------------------- |
| `TERMINAL_TIMEOUT_MS`  | `8000`  | Max runtime per command (ms).             |
| `TERMINAL_MAX_OUTPUT`  | `65536` | Max output bytes per command.             |
| `TERMINAL_PKG_DELAY_MS`| `350`   | Delay between simulated package progress lines. |
| `TERMINAL_USER`        | `user`  | Virtual user shown in the prompt.         |
| `TERMINAL_HOST`        | `term`  | Virtual hostname shown in the prompt.     |

Every variable is optional in development; set the marked ones in production.
(Documentation lives in this README because `.env*` files are treated as
secrets by some hosting tooling.)

---

## Deploying to Vercel

1. Push this folder (or set the Vercel project root to `web-terminal-simulator`).
2. Add env vars in **Vercel → Project → Settings → Environment Variables**:
   `TERMINAL_AUTH_TOKEN`, `SESSION_SECRET`, `CRON_SECRET` (required), plus
   `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `POSTGRES_URL`) for persistence.
3. Framework preset: **Next.js**. Build command: `next build`.
4. `vercel.json` defines the cron: `/api/cron/trigger` every minute. Vercel
   sends it with `Authorization: Bearer <CRON_SECRET>`.
5. **Vercel Cron limits change** — check the current docs
   (https://vercel.com/docs/cron-jobs) for the number of crons and minimum
   interval on your plan. Jobs whose schedules are finer than the trigger's
   granularity simply won't fire more often than the trigger does.

### What does and doesn't work on Vercel

| Works                                                        | Does NOT work                                          |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Virtual shell commands, virtual FS, history, `pkg`/`apt` registry installs | Real `apt-get`/`pkg` binary installs            |
| Server-side state (KV/Postgres/Blob), cron jobs, execution logs | Interactive PTY / long-running processes        |
| SSE streaming of command output                              | Running a Linux shell (no persistent process)         |
| Auth + rate limiting (best-effort per instance)              | Guaranteed global rate limiting                        |

---

## API reference

| Endpoint                     | Method(s)      | Auth        | Purpose                                    |
| ---------------------------- | -------------- | ----------- | ------------------------------------------ |
| `/api/terminal/exec`         | POST           | token/session | Run a command. Body `{ command, stream? }`; `stream: true` returns SSE. |
| `/api/terminal/state`        | GET            | token/session | Virtual state: cwd, env, packages, history, mode. |
| `/api/terminal/auth`         | GET            | public      | Probe: is auth required, does this browser have a session. |
| `/api/auth/session`          | POST / DELETE  | token       | Exchange `TERMINAL_AUTH_TOKEN` for an HttpOnly session cookie. |
| `/api/cron/jobs`             | GET / POST     | token/session | List / create cron jobs.                   |
| `/api/cron/jobs/[id]`        | GET / PATCH / DELETE | token/session | Read, update, delete a cron job.    |
| `/api/cron/trigger`          | POST / GET     | `CRON_SECRET` | Vercel Cron entry point; `?jobId=` for manual runs. |

Example — run a command:

```bash
curl -s -X POST http://localhost:3000/api/terminal/exec \
  -H "Authorization: Bearer $TERMINAL_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Terminal-Session: demo-session" \
  -d '{"command":"pkg install git"}'
```

Example — trigger a cron job manually:

```bash
curl -s -X POST "http://localhost:3000/api/cron/trigger?jobId=<id>" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Cron jobs

- Create via `POST /api/cron/jobs` with `{ name, schedule, command, enabled }`.
- `schedule` is a 5-field cron expression, validated with `cron-parser`.
- `command` must pass the same allowlist/danger policy as interactive commands
  (no `cron` inside cron, no dangerous patterns).
- Execution logs are stored per job (last 50 runs) — see `GET
  /api/cron/jobs/[id]` or the `cron logs <id>` shell command.
- Inside the terminal: `cron list`, `cron add <name> "<schedule>" <command>`,
  `cron rm <id>`, `cron run <id>`, `cron logs <id>`.

---

## Deploying the PTY backend (MODE 2)

The backend lives in `server/pty-server/` and is deliberately NOT part of the
Next.js build (its native dependency `node-pty` must be compiled in its own
image).

```bash
cd server/pty-server
# quick local test
TERMINAL_AUTH_TOKEN=devtoken npm install && npm start
# or Docker
docker compose up -d --build
```

Point the frontend at it:

```env
NEXT_PUBLIC_TERMINAL_MODE=pty
NEXT_PUBLIC_PTY_WS_URL=wss://your-host:8080/ws
# browser token for the backend:
NEXT_PUBLIC_PTY_WS_TOKEN=devtoken
```

Security checklist for production:

- Set a strong `TERMINAL_AUTH_TOKEN` on the backend.
- Run behind TLS (reverse proxy / Fly.io / Render).
- The Docker image runs the shell as a **non-root** user (`term`).
- `MAX_CLIENTS` / `MAX_PER_IP` / `IDLE_TIMEOUT_MS` are configurable.
- If you want `apt`/`pkg` to install real packages, the shell must run in a
  container with persistent volumes and controlled permissions — never as
  root on the host.

---

## Storage & data model

Keys stored through the `StorageAdapter`:

| Key                          | Content                                      |
| ---------------------------- | -------------------------------------------- |
| `term:session:<id>:state`    | Virtual shell state (cwd, env, fs, packages) |
| `term:session:<id>:history`  | Command history (last 200)                   |
| `term:cron:jobs`             | Cron job list                                |
| `term:cron:logs:<jobId>`     | Execution logs (last 50)                     |

The browser never stores important state in `localStorage`. Only a
non-sensitive session id cookie (`term_sid`) is set so history/state follow
the browser across reloads.

---

## Security

- No `eval`, no `new Function`, no shell execution from user input anywhere
  in serverless mode — commands are resolved against a fixed registry.
- Danger policy blocks `rm -rf /`, `sudo`, `mkfs`, `dd of=/dev/*`,
  `curl|sh`, `wget|sh`, fork bombs, `/dev/*` writes, and similar patterns
  (`lib/terminal/commandParser.ts`).
- Auth via `TERMINAL_AUTH_TOKEN` (Bearer or HttpOnly cookie), `CRON_SECRET`
  for the cron trigger, per-IP rate limits on all routes (in-memory —
  best-effort per serverless instance).
- Secrets are never logged. Output is capped. Timeouts abort commands.
- **Limitations to repeat out loud:**
  - Real PTY is impossible on Vercel serverless — use MODE 2.
  - `pkg`/`apt` installs are virtual; they will not run real binaries.
  - In-memory storage is ephemeral; configure KV/Postgres for persistence.
  - Vercel Cron delivery is not exactly-once; the trigger uses a grace window
    and can skip or double-fire on delays.
  - In-memory rate limits reset when serverless instances spin down.

## Project structure

```
app/api/auth/session/route.ts     # token → session cookie exchange
app/api/cron/jobs/route.ts        # cron job CRUD
app/api/cron/jobs/[id]/route.ts
app/api/cron/trigger/route.ts     # Vercel Cron entry point (CRON_SECRET)
app/api/terminal/auth/route.ts    # auth probe
app/api/terminal/exec/route.ts    # command execution (JSON + SSE)
app/api/terminal/state/route.ts   # virtual state
components/Terminal.tsx           # xterm.js wrapper (fit/resize/focus)
components/TerminalShell.tsx      # shell UI, line editor, mode handling
lib/auth/auth.ts                  # Bearer + session cookie auth
lib/auth/rateLimit.ts             # in-memory rate limiter
lib/config/env.ts                 # server env configuration
lib/cron/scheduler.ts             # cron CRUD + logs
lib/cron/runner.ts                # cron execution
lib/cron/validator.ts             # cron expression validation
lib/storage/*                     # memory / KV / Blob / Postgres adapters
lib/terminal/commandParser.ts     # safe parser + danger policy
lib/terminal/commandRegistry.ts   # virtual shell commands
lib/terminal/knownCommands.ts     # client-safe command list
lib/terminal/packageRegistry.ts   # virtual package registry
lib/terminal/ptyClient.ts         # WebSocket client for MODE 2
lib/terminal/serverlessExecutor.ts# command runner (MODE 1)
lib/terminal/types.ts             # shared types
lib/terminal/virtualFs.ts         # virtual filesystem
server/pty-server/                # real PTY backend (Docker/VPS)
vercel.json                       # cron schedule
```
