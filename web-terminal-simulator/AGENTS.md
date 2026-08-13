<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Platform limitations (term)

Do not claim capabilities this app does not have:

- **Vercel cannot host a real interactive PTY.** Serverless functions have no
  persistent processes. MODE 1 (the default) is a virtual command runner —
  allowlisted commands over a virtual filesystem/package registry. Real PTYs
  require MODE 2 (`server/pty-server/`, deployed on a VPS/Docker/Fly.io/Render).
- **`pkg`/`apt` installs in serverless mode are virtual.** They register
  manifest entries and `/usr/bin` stubs; no binary is downloaded or executed.
- **In-memory storage is ephemeral.** The app prefers Vercel KV/Postgres/Blob
  when credentials are present; `storage` command reports the active backend.
- **Vercel Cron is not exactly-once.** `/api/cron/trigger` uses a grace
  window; jobs can be skipped or double-fired on delayed delivery.
- Do not add `node-pty`/`ws` to the Next.js app dependencies — they belong in
  `server/pty-server/`'s own package.json (native module, separate image).
