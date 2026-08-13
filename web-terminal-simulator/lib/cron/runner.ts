import { env } from "@/lib/config/env";
import { appendJobLog, getJob, updateJob } from "@/lib/cron/scheduler";
import { getStorage } from "@/lib/storage";
import { ServerlessExecutor } from "@/lib/terminal/serverlessExecutor";
import type { CronJob, CronLog } from "@/lib/terminal/types";

export type RunJobResult =
  | { ok: true; log: CronLog; job: CronJob }
  | { ok: false; error: string };

/**
 * Executes a cron job's command inside the virtual shell, using a dedicated
 * per-job session (`cron:<jobId>`) so its virtual filesystem/packages
 * persist between runs. Records a log entry and updates the job status.
 */
export async function runJob(jobId: string, options: { force?: boolean } = {}): Promise<RunJobResult> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, error: `job '${jobId}' not found` };
  if (!job.enabled && !options.force) return { ok: false, error: "job is disabled" };

  const storage = await getStorage();
  const executor = new ServerlessExecutor(storage);
  const startedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.timeoutMs + 5000);
  let output = "";
  let timedOut = false;
  let rejected = false;
  let exitCode = 0;
  try {
    const result = await executor.run(`cron:${jobId}`, job.command, {
      signal: controller.signal,
      isCron: true,
    });
    output = result.output;
    timedOut = result.timedOut;
    rejected = result.rejected;
    exitCode = result.exitCode;
  } catch (error) {
    output = `cron: execution failed: ${(error as Error).message}\n`;
    exitCode = 1;
  } finally {
    clearTimeout(timer);
  }

  const status: NonNullable<CronLog["status"]> = timedOut
    ? "timeout"
    : rejected
      ? "rejected"
      : exitCode !== 0
        ? "error"
        : "success";

  const log: CronLog = {
    jobId,
    status,
    output: output.slice(0, 4000),
    startedAt,
    finishedAt: Date.now(),
    ...(exitCode !== 0 ? { error: output.slice(0, 500) } : {}),
  };
  await appendJobLog(jobId, log);
  await updateJob(jobId, { lastRunAt: startedAt, lastStatus: status });

  return { ok: true, log, job: { ...job, lastRunAt: startedAt, lastStatus: status } };
}
