import {
  buildClearCookieHeader,
  buildSessionCookieHeader,
  createSessionCookieValue,
  tokensMatch,
} from "@/lib/auth/auth";
import { env } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/session  { token: string }
 * Exchanges TERMINAL_AUTH_TOKEN for an HttpOnly session cookie so the
 * terminal does not need to keep the raw token in browser storage.
 *
 * DELETE /api/auth/session — clears the session cookie.
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.authToken) {
    return Response.json({ ok: true, note: "auth is not configured" });
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return Response.json({ error: "token is required" }, { status: 400 });
  }
  if (!tokensMatch(token, env.authToken)) {
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSessionCookieHeader(createSessionCookieValue()),
    },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildClearCookieHeader(),
    },
  });
}
