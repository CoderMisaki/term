import { z } from "zod";
import { getClientIp, requireAuth } from "@/lib/auth/auth";
import { checkRateLimit, rateLimitedResponse } from "@/lib/auth/rateLimit";
import { createJob, listJobs } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createJobSchema = z.object({
  name: z.string().min(1).max(64),
  schedule: z.string().min(1).max(64),
  command: z.string().min(1).max(500),
  enabled: z.boolean().optional(),
});

/** GET /api/cron/jobs — list all cron jobs. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`cron:list:${ip}`, 60, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  const jobs = (await listJobs()).sort((a, b) => b.createdAt - a.createdAt);
  return Response.json({ jobs });
}

/** POST /api/cron/jobs — create a cron job (schedule + command validated). */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response!;

  const ip = getClientIp(request);
  const rate = checkRateLimit(`cron:create:${ip}`, 20, 60_000);
  if (!rate.ok) return rateLimitedResponse(rate.retryAfterSec!);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createJobSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.issues.map((issue) => issue.message) },
      { status: 400 },
    );
  }

  const result = await createJob(parsed.data);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ job: result.value }, { status: 201 });
}
