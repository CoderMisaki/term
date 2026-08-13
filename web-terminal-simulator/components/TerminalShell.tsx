"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import { Database, Loader2, RefreshCw, ShieldAlert, Terminal as TerminalIcon, Wifi, WifiOff } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { KNOWN_COMMANDS } from "@/lib/terminal/knownCommands";
import { PtyClient, type PtyStatus } from "@/lib/terminal/ptyClient";

const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

const HOME_DIR = "/home/user";
const SESSION_COOKIE = "term_sid";

type BootState = "booting" | "auth" | "ready" | "failed";

function shortPath(cwd: string): string {
  if (cwd === HOME_DIR) return "~";
  if (cwd.startsWith(HOME_DIR + "/")) return "~" + cwd.slice(HOME_DIR.length);
  return cwd;
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export default function TerminalShell() {
  const [boot, setBoot] = useState<BootState>("booting");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageMode, setStorageMode] = useState("memory");
  const [status, setStatus] = useState<PtyStatus | "idle">("idle");

  // NEXT_PUBLIC_* vars are inlined by Next.js at build time.
  const [ptyConfigured] = useState(
    () => process.env.NEXT_PUBLIC_TERMINAL_MODE === "pty" && Boolean(process.env.NEXT_PUBLIC_PTY_WS_URL),
  );

  const termRef = useRef<XTerm | null>(null);
  const bufRef = useRef("");
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const bannerShownRef = useRef(false);
  const userRef = useRef("user");
  const hostRef = useRef("term");
  const cwdRef = useRef(HOME_DIR);
  const sessionIdRef = useRef<string | null>(null);
  const tokenRef = useRef("");
  const ptyRef = useRef<PtyClient | null>(null);

  /* ---------------------------------------------------------------- */
  /* Session id (client-generated, non-sensitive, cookie-persisted)    */
  /* ---------------------------------------------------------------- */

  const ensureSessionId = useCallback((): string => {
    if (sessionIdRef.current) return sessionIdRef.current;
    let id = readCookie(SESSION_COOKIE);
    if (!id) {
      id = makeId();
      if (typeof document !== "undefined") {
        document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
      }
    }
    sessionIdRef.current = id;
    return id;
  }, []);

  const apiHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { "X-Terminal-Session": ensureSessionId() };
    if (tokenRef.current) headers.Authorization = `Bearer ${tokenRef.current}`;
    return headers;
  }, [ensureSessionId]);

  /* ---------------------------------------------------------------- */
  /* Prompt + banner                                                    */
  /* ---------------------------------------------------------------- */

  const promptText = useCallback((): string => {
    const user = userRef.current || "user";
    const host = hostRef.current || "term";
    const dir = shortPath(cwdRef.current);
    return `\x1b[1;32m${user}@${host}\x1b[0m:\x1b[1;34m${dir}\x1b[0m$ `;
  }, []);

  const writePrompt = useCallback(
    (term: XTerm) => {
      term.write(promptText());
    },
    [promptText],
  );

  const writeBanner = useCallback((term: XTerm, summary?: { user: string; host: string; cwd: string }) => {
    if (summary) {
      userRef.current = summary.user;
      hostRef.current = summary.host;
      cwdRef.current = summary.cwd;
    }
    term.writeln("");
    term.writeln("\x1b[1;32m  term\x1b[0m — sandboxed web terminal");
    term.writeln("  ───────────────────────────────────────");
    term.writeln(
      ptyConfigured
        ? "  Mode: \x1b[1;36mreal PTY backend\x1b[0m (MODE 2) — commands run in a real Linux shell."
        : "  Mode: \x1b[1;36mserverless virtual shell\x1b[0m (MODE 1) — allowlisted commands,\n  virtual filesystem, no real binaries. Type 'help' for the command list.",
    );
    term.writeln("  Type 'vercel' for platform info, 'storage' for the storage backend.\r\n");
  }, [ptyConfigured]);

  /* ---------------------------------------------------------------- */
  /* Boot: probe auth, then load server-side state                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/terminal/auth");
        const info = (await res.json()) as {
          required?: boolean;
          hasSession?: boolean;
          storageMode?: string;
        };
        if (cancelled) return;
        setStorageMode(info.storageMode ?? "memory");
        const needAuth = info.required === true && info.hasSession !== true;
        setBoot(needAuth ? "auth" : "ready");
      } catch {
        if (!cancelled) setBoot("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boot !== "ready" || bannerShownRef.current) return;
    const term = termRef.current;
    if (!term) return;
    bannerShownRef.current = true;

    if (ptyConfigured) {
      writeBanner(term);
      return;
    }

    fetch("/api/terminal/state", { headers: apiHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((summary: { user?: string; host?: string; cwd?: string } | null) => {
        const current = termRef.current;
        if (!current) return;
        writeBanner(
          current,
          summary
            ? {
                user: summary.user ?? "user",
                host: summary.host ?? "term",
                cwd: summary.cwd ?? HOME_DIR,
              }
            : undefined,
        );
        writePrompt(current);
      })
      .catch(() => {
        const current = termRef.current;
        if (current) {
          writeBanner(current);
          writePrompt(current);
        }
      });
  }, [boot, ptyConfigured, apiHeaders, writeBanner, writePrompt]);

  /* ---------------------------------------------------------------- */
  /* Auth                                                               */
  /* ---------------------------------------------------------------- */

  const submitAuth = useCallback(
    async (value: string) => {
      setAuthError("");
      if (!value.trim()) {
        setAuthError("Token is required.");
        return;
      }
      try {
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: value }),
        });
        if (!res.ok) {
          setAuthError("Invalid token — check TERMINAL_AUTH_TOKEN on the server.");
          return;
        }
        tokenRef.current = value;
        setBoot("ready");
      } catch {
        setAuthError("Could not reach the server.");
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Serverless command execution (SSE streaming with JSON fallback)    */
  /* ---------------------------------------------------------------- */

  const consumeSSE = useCallback(async (response: Response, term: XTerm) => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const lines = raw.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === "output" && typeof payload.text === "string") {
            term.write(payload.text);
          } else if (event === "result" && typeof payload.cwd === "string") {
            cwdRef.current = payload.cwd;
          } else if (event === "error") {
            term.write(`\x1b[31m${String(payload.error ?? "unknown error")}\x1b[0m\n`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }, []);

  const runCommand = useCallback(
    async (command: string) => {
      const term = termRef.current;
      if (!term) return;
      runningRef.current = true;
      setBusy(true);
      try {
        const res = await fetch("/api/terminal/exec", {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ command, stream: true }),
        });
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          await consumeSSE(res, term);
        } else {
          const data = (await res.json().catch(() => null)) as {
            error?: string;
            output?: string;
            timedOut?: boolean;
            cwd?: string;
          } | null;
          if (!res.ok) {
            term.write(`\x1b[31m${data?.error ?? `HTTP ${res.status}`}\x1b[0m\n`);
          } else if (data) {
            if (data.output) term.write(data.output);
            if (data.timedOut) term.write("\n\x1b[31m[command timed out]\x1b[0m\n");
            if (data.cwd) cwdRef.current = data.cwd;
          }
        }
      } catch (error) {
        term.write(`\x1b[31mterm: request failed — ${(error as Error).message}\x1b[0m\n`);
      } finally {
        runningRef.current = false;
        setBusy(false);
        const next = queueRef.current.shift();
        if (next) {
          void runCommand(next);
        } else {
          writePrompt(term);
        }
      }
    },
    [apiHeaders, consumeSSE, writePrompt],
  );

  /* ---------------------------------------------------------------- */
  /* Line editor (serverless mode only)                                 */
  /* ---------------------------------------------------------------- */

  const replaceInput = useCallback(
    (value: string) => {
      const term = termRef.current;
      if (!term) return;
      term.write("\r\x1b[K");
      bufRef.current = value;
      term.write(promptText() + value);
    },
    [promptText],
  );

  const submit = useCallback(() => {
    const term = termRef.current;
    if (!term || ptyConfigured) return;
    const command = bufRef.current.trim();
    const rawLine = bufRef.current;
    bufRef.current = "";
    histRef.current.push(rawLine);
    histIdxRef.current = -1;
    term.write("\r\n");
    if (!command) {
      writePrompt(term);
      return;
    }
    if (command === "clear") {
      term.clear();
      writePrompt(term);
      return;
    }
    if (runningRef.current) {
      queueRef.current.push(command);
      return;
    }
    void runCommand(command);
  }, [ptyConfigured, runCommand, writePrompt]);

  const ctrlC = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    bufRef.current = "";
    histIdxRef.current = -1;
    term.write("^C\r\n");
    writePrompt(term);
  }, [writePrompt]);

  const historyPrev = useCallback(() => {
    const term = termRef.current;
    if (!term || histRef.current.length === 0) return;
    if (histIdxRef.current === -1) histIdxRef.current = histRef.current.length - 1;
    else if (histIdxRef.current > 0) histIdxRef.current -= 1;
    replaceInput(histRef.current[histIdxRef.current]);
  }, [replaceInput]);

  const historyNext = useCallback(() => {
    if (histIdxRef.current === -1) return;
    histIdxRef.current += 1;
    if (histIdxRef.current >= histRef.current.length) {
      histIdxRef.current = -1;
      replaceInput("");
    } else {
      replaceInput(histRef.current[histIdxRef.current]);
    }
  }, [replaceInput]);

  const completeTab = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const parts = bufRef.current.split(" ");
    const current = parts[parts.length - 1];
    if (parts.length === 1) {
      const matches = KNOWN_COMMANDS.filter((name) => name.startsWith(current));
      if (current && matches.length === 1 && current !== matches[0]) {
        replaceInput(`${matches[0]} `);
      } else if (current && matches.length > 1) {
        term.write("\r\n" + matches.join("  ") + "\r\n");
        term.write(promptText() + bufRef.current);
      }
    }
  }, [promptText, replaceInput]);

  const onData = useCallback(
    (data: string) => {
      const pty = ptyRef.current;
      if (pty) {
        pty.sendData(data);
        return;
      }
      const term = termRef.current;
      if (!term) return;
      for (const char of data) {
        // \r from Enter, \n from multi-line pastes — both submit the line.
        if (char === "\r" || char === "\n") {
          submit();
        } else if (char === "\x7f" || char === "\b") {
          if (bufRef.current.length > 0) {
            bufRef.current = bufRef.current.slice(0, -1);
            term.write("\b \b");
          }
        } else if (char === "\x03") {
          ctrlC();
        } else if (char === "\t") {
          completeTab();
        } else if (char === "\x1b[A") {
          historyPrev();
        } else if (char === "\x1b[B") {
          historyNext();
        } else if (char === "\x1b[C" || char === "\x1b[D") {
          // Left/right arrows: cursor editing not supported — ignore.
        } else if (char.charCodeAt(0) >= 0x20) {
          bufRef.current += char;
          term.write(char);
        }
      }
    },
    [completeTab, ctrlC, historyNext, historyPrev, submit],
  );

  /* ---------------------------------------------------------------- */
  /* PTY mode                                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (boot !== "ready" || !ptyConfigured) return;
    const term = termRef.current;
    if (!term) return;
    const url = process.env.NEXT_PUBLIC_PTY_WS_URL ?? "";
    const token = tokenRef.current || process.env.NEXT_PUBLIC_PTY_WS_TOKEN || "";
    const client = new PtyClient(url, token, {
      onData: (chunk) => termRef.current?.write(chunk),
      onStatus: (nextStatus) => setStatus(nextStatus),
      onExit: (exitCode) => {
        termRef.current?.writeln(`\r\n\x1b[33m[shell exited with code ${exitCode}]\x1b[0m`);
      },
    });
    ptyRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      ptyRef.current = null;
    };
  }, [boot, ptyConfigured]);

  const handleResize = useCallback((cols: number, rows: number) => {
    ptyRef.current?.sendResize(cols, rows);
  }, []);

  const handleTermReady = useCallback((term: XTerm) => {
    termRef.current = term;
  }, []);

  /* ---------------------------------------------------------------- */
  /* Render                                                             */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex h-dvh min-h-dvh flex-col overflow-hidden bg-[#0b0f14] text-zinc-100">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/90 px-3 sm:px-4">
        <TerminalIcon className="h-4 w-4 text-emerald-400" />
        <span className="text-xs font-semibold tracking-wide text-zinc-200">term</span>
        <span className="hidden text-[10px] uppercase tracking-widest text-zinc-500 sm:inline">
          web terminal
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400 md:inline">
            {ptyConfigured ? "mode: pty" : "mode: serverless"}
          </span>
          <span className="hidden rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400 sm:inline">
            <Database className="mr-1 inline h-3 w-3 text-zinc-500" />
            {storageMode}
          </span>
          {ptyConfigured ? (
            status === "open" ? (
              <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                <Wifi className="h-3 w-3" /> connected
              </span>
            ) : status === "error" ? (
              <span className="flex items-center gap-1 text-[10px] text-red-400">
                <WifiOff className="h-3 w-3" /> disconnected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" /> connecting
              </span>
            )
          ) : busy ? (
            <span className="flex items-center gap-1 text-[10px] text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" /> running
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> ready
            </span>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Reconnect terminal"
            title="Reconnect"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col p-2 pb-safe sm:p-3 md:p-4">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800/80 bg-[#0b0f14] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <Terminal
            onData={onData}
            onResize={handleResize}
            onReady={handleTermReady}
            autoFocus
            className="h-full w-full"
          />

          {boot === "booting" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b0f14]">
              <div className="flex items-center gap-3 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading terminal…
              </div>
            </div>
          )}

          {boot === "failed" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b0f14] p-4">
              <div className="max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-center">
                <ShieldAlert className="mx-auto h-6 w-6 text-red-400" />
                <h2 className="mt-3 text-sm font-semibold text-zinc-100">Could not reach the server</h2>
                <p className="mt-2 text-xs text-zinc-400">
                  The terminal API did not respond. Check that the app is running and try again.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-xs font-medium text-emerald-950 hover:bg-emerald-400"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {boot === "auth" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b0f14]/95 p-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = new FormData(event.currentTarget).get("token");
                  void submitAuth(typeof input === "string" ? input : "");
                }}
                className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl"
              >
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-amber-400" />
                  <h2 className="text-sm font-semibold text-zinc-100">Authentication required</h2>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  This deployment requires the terminal access token (
                  <code className="text-zinc-300">TERMINAL_AUTH_TOKEN</code>). It is held in memory
                  and exchanged for a session cookie — nothing sensitive is stored in the browser.
                </p>
                <input
                  name="token"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  placeholder="Access token"
                  className="mt-4 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-emerald-400"
                />
                {authError && <p className="mt-2 text-xs text-red-400">{authError}</p>}
                <button
                  type="submit"
                  className="mt-4 w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-400"
                >
                  Unlock terminal
                </button>
              </form>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
