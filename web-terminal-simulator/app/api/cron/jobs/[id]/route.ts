import { z } from "zod";
import { getClientIp, requireAuth } from "@/lib/auth/auth";
import { checkRateLimit, rateLimitedResponse } from "@/lib/auth/rateLimit";
import { deleteJob, getJob, updateJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchJobSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  schedule: z.string().min(1).max(64).optional(),
  command: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/cron/jobs/[id] — fetch a single job. */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return Response.json({ error: "Cron job not found" }, { status: 404 });
  return Response.json({ job });
}

/** PATCH /api/cron/jobs/[id] — update name/schedule/command/enabled. */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`cron:update:${ip}`, 30, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchJobSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.issues.map((issue) => issue.message) },
      { status: 400 },
    );
  }

  const { id } = await ctx.params;
  const result = await updateJob(id, parsed.data);
  if (!result.ok) {
    const status = result.error.includes("not found") ? 404 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ job: result.value });
}

/** DELETE /api/cron/jobs/[id] — remove a cron job. */
export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`cron:delete:${ip}`, 30, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  const { id } = await ctx.params;
  const deleted = await deleteJob(id);
  if (!deleted) return Response.json({ error: "Cron job not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
