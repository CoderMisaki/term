import { getClientIp, getSessionId, requireAuth } from "@/lib/auth/auth";
import { checkRateLimit, rateLimitedResponse } from "@/lib/auth/rateLimit";
import { env } from "@/lib/config/env";
import { getStorage } from "@/lib/storage";
import { COMMAND_LIMIT, ServerlessExecutor } from "@/lib/terminal/serverlessExecutor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExecBody {
  command?: unknown;
  stream?: unknown;
}

/**
 * POST /api/terminal/exec
 *
 * Body: { command: string, stream?: boolean }
 *
 * - Authenticates via Bearer token or session cookie (when TERMINAL_AUTH_TOKEN is set).
 * - Rate-limits per client IP.
 * - Runs the command through the allowlisted virtual shell with a timeout.
 * - With `stream: true` responds with Server-Sent Events so long output
 *   (e.g. package installs) renders progressively.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`exec:${ip}`, 60, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  let body: ExecBody;
  try {
    body = (await request.json()) as ExecBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body.command !== "string" ||
    body.command.length === 0 ||
    body.command.length > COMMAND_LIMIT
  ) {
    return Response.json(
      { error: `command must be a non-empty string of at most ${COMMAND_LIMIT} characters` },
      { status: 400 },
    );
  }

  const sessionId = getSessionId(request);
  const storage = await getStorage();
  const executor = new ServerlessExecutor(storage);

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), env.timeoutMs + 3000);
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);

  try {
    if (body.stream === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };
          try {
            const result = await executor.run(sessionId, body.command as string, {
              signal,
              onOutput: (chunk) => send("output", { text: chunk }),
            });
            send("result", { ...result });
          } catch (error) {
            send("error", { error: (error as Error).message });
          } finally {
            clearTimeout(timer);
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const result = await executor.run(sessionId, body.command as string, { signal });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
