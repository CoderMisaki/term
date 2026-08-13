import { tokensMatch } from "@/lib/auth/auth";
import { cronMatchesNow } from "@/lib/cron/validator";
import { runJob } from "@/lib/cron/runner";
import { listJobs } from "@/lib/cron/scheduler";
import { env } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST/GET /api/cron/trigger
 *
 * Called by Vercel Cron (configured in vercel.json). Vercel automatically
 * sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set in the
 * project environment — that header is validated here.
 *
 * - ?jobId=<id>  → runs a single job immediately (manual trigger).
 * - no param     → runs every enabled job whose schedule matches the current
 *                  minute (best-effort; see lib/cron/validator.ts).
 */
export async function POST(request: Request): Promise<Response> {
  return handleTrigger(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleTrigger(request);
}

async function handleTrigger(request: Request): Promise<Response> {
  if (!env.cronSecret) {
    return Response.json(
      {
        error:
          "CRON_SECRET is not configured. Set it in the project environment to enable cron triggers.",
      },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!tokensMatch(bearer, env.cronSecret)) {
    return Response.json({ error: "Unauthorized — invalid CRON_SECRET" }, { status: 401 });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");

  if (jobId) {
    const result = await runJob(jobId, { force: true });
    if (!result.ok) return Response.json({ error: result.error }, { status: 404 });
    return Response.json({
      ran: 1,
      results: [{ jobId, status: result.log.status, durationMs: result.log.finishedAt - result.log.startedAt }],
    });
  }

  const jobs = await listJobs();
  const now = new Date();
  const due = jobs.filter((job) => job.enabled && cronMatchesNow(job.schedule, now));

  const results: Array<{ jobId: string; status: string; error?: string }> = [];
  for (const job of due) {
    const result = await runJob(job.id);
    results.push({
      jobId: job.id,
      status: result.ok ? result.log.status : "error",
      ...(result.ok ? {} : { error: result.error }),
    });
  }

  return Response.json({
    ran: results.length,
    totalJobs: jobs.length,
    due: due.map((job) => job.id),
    results,
    note: "Best-effort trigger — verify current Vercel Cron limits in the Vercel docs.",
  });
}
