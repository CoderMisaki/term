import type { TerminalMode } from "@/lib/terminal/types";

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Server-side configuration. Never import this module from client components:
 * it reads server-only env vars (they are safe to read here because these
 * values never leak to the browser bundle).
 */
export const env = {
  /** When set, all terminal/cron API routes require a Bearer token or a signed session cookie. */
  authToken: process.env.TERMINAL_AUTH_TOKEN?.trim() ?? "",
  /** Used to sign the session cookie (falls back to authToken when absent). */
  sessionSecret: process.env.SESSION_SECRET?.trim() ?? "",
  /** Required by Vercel Cron to authenticate /api/cron/trigger. */
  cronSecret: process.env.CRON_SECRET?.trim() ?? "",
  /** Override the auto-detected storage driver. */
  storageDriver: process.env.STORAGE_DRIVER?.trim().toLowerCase() ?? "",

  /** Virtual identity shown in the prompt. */
  user: process.env.TERMINAL_USER?.trim() || "user",
  host: process.env.TERMINAL_HOST?.trim() || "term",

  /** Command execution limits. */
  timeoutMs: positiveInt(process.env.TERMINAL_TIMEOUT_MS, 8000),
  maxOutput: positiveInt(process.env.TERMINAL_MAX_OUTPUT, 65536),
  /** Simulated delay between package-manager progress lines. */
  pkgDelayMs: positiveInt(process.env.TERMINAL_PKG_DELAY_MS, 350),

  isVercel: !!process.env.VERCEL_URL || process.env.VERCEL === "1" || process.env.VERCEL === "true",
  vercelEnv: process.env.VERCEL_ENV ?? null,
  vercelRegion: process.env.VERCEL_REGION ?? null,

  /** Client-exposed mode (inlined by Next.js into the browser bundle). */
  clientMode: (process.env.NEXT_PUBLIC_TERMINAL_MODE === "pty" ? "pty" : "serverless") as TerminalMode,
  ptyWsUrl: process.env.NEXT_PUBLIC_PTY_WS_URL?.trim() ?? "",
  /** Optional client token for the PTY backend in development. */
  ptyWsToken: process.env.NEXT_PUBLIC_PTY_WS_TOKEN?.trim() ?? "",
} as const;
