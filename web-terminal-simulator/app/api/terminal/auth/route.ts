import { hasSessionCookie } from "@/lib/auth/auth";
import { env } from "@/lib/config/env";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public probe used by the frontend on boot. It intentionally reveals only
 * non-sensitive configuration: whether a token is required, whether this
 * browser already holds a valid session cookie, and the active mode/storage.
 */
export async function GET(request: Request): Promise<Response> {
  const storage = await getStorage();
  return Response.json({
    required: env.authToken.length > 0,
    hasSession: hasSessionCookie(request),
    mode: env.clientMode,
    storageMode: storage.kind,
    onVercel: env.isVercel,
    ptyConfigured: env.clientMode === "pty" && env.ptyWsUrl.length > 0,
  });
}
