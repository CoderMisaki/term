import { getClientIp, getSessionId, requireAuth } from "@/lib/auth/auth";
import { checkRateLimit, rateLimitedResponse } from "@/lib/auth/rateLimit";
import { env } from "@/lib/config/env";
import { getStorage } from "@/lib/storage";
import { ServerlessExecutor } from "@/lib/terminal/serverlessExecutor";
import type { TerminalStateSummary } from "@/lib/terminal/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/terminal/state — virtual shell state for the current session. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`state:${ip}`, 120, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  const sessionId = getSessionId(request);
  const storage = await getStorage();
  const executor = new ServerlessExecutor(storage);
  const [state, history] = await Promise.all([
    executor.loadState(sessionId),
    executor.loadHistory(sessionId),
  ]);

  const summary: TerminalStateSummary = {
    mode: env.clientMode,
    storageMode: storage.kind,
    cwd: state.cwd,
    env: state.env,
    packages: Object.values(state.packages).sort((a, b) => a.name.localeCompare(b.name)),
    history: history.slice(-100),
    sessionId,
    user: state.env.USER ?? env.user,
    host: env.host,
    onVercel: env.isVercel,
    timeoutMs: env.timeoutMs,
    maxOutput: env.maxOutput,
  };
  return Response.json(summary);
}
