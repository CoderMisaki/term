import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/config/env";

export const SESSION_COOKIE = "term_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(payload: string): string {
  const key = env.sessionSecret || env.authToken;
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionCookieValue(): string {
  const payload = `exp=${Date.now() + SESSION_MAX_AGE_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookieValue(value: string | undefined | null): boolean {
  if (!value) return false;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!payload.startsWith("exp=")) return false;
  const expiresAt = Number(payload.slice(4));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(signature, sign(payload));
}

export function buildSessionCookieHeader(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  const secure = env.isVercel ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function buildClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

export interface AuthResult {
  ok: boolean;
  response?: Response;
  authenticated: boolean;
}

/**
 * Enforces terminal API auth. When TERMINAL_AUTH_TOKEN is unset the API is
 * open (development convenience) — the README warns to set it in production.
 */
export async function requireAuth(request: Request): Promise<AuthResult> {
  if (!env.authToken) return { ok: true, authenticated: false };

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (bearer && safeEqual(bearer, env.authToken)) {
    return { ok: true, authenticated: true };
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const session = cookies.get(SESSION_COOKIE);
  if (session && verifySessionCookieValue(session)) {
    return { ok: true, authenticated: true };
  }

  return {
    ok: false,
    authenticated: false,
    response: Response.json(
      { error: "Unauthorized — provide Authorization: Bearer <TERMINAL_AUTH_TOKEN> or a valid session cookie" },
      { status: 401 },
    ),
  };
}

/** Constant-time comparison for arbitrary secrets (e.g. CRON_SECRET). */
export function tokensMatch(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  return safeEqual(actual, expected);
}

export function hasSessionCookie(request: Request): boolean {
  const cookies = parseCookies(request.headers.get("cookie"));
  return verifySessionCookieValue(cookies.get(SESSION_COOKIE));
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Session id: client-generated and sent via header or cookie. */
export function getSessionId(request: Request): string {
  const header = request.headers.get("x-terminal-session")?.trim();
  if (header && header.length <= 128) return header;
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookie = cookies.get("term_sid");
  if (cookie && cookie.length <= 128) return cookie;
  return crypto.randomUUID();
}
