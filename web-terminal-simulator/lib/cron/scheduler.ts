import { randomUUID } from "node:crypto";
import { isValidCronSchedule } from "@/lib/cron/validator";
import { getStorage } from "@/lib/storage";
import { isDangerousCommand, parseCommandLine } from "@/lib/terminal/commandParser";
import { COMMANDS } from "@/lib/terminal/commandRegistry";
import type { CronJob, CronLog } from "@/lib/terminal/types";

const JOBS_KEY = "term:cron:jobs";
const LOG_PREFIX = "term:cron:logs:";
const LOG_LIMIT = 50;

export interface CreateJobInput {
  name: string;
  schedule: string;
  command: string;
  enabled?: boolean;
}

export type JobPatch = Partial<Pick<CronJob, "enabled" | "name" | "schedule" | "command" | "lastRunAt" | "lastStatus">>;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function validateJobFields(input: { name?: string; schedule?: string; command?: string }): string | null {
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 64) return "name must be 1-64 characters";
  }
  if (input.schedule !== undefined && !isValidCronSchedule(input.schedule)) {
    return `invalid cron schedule: ${input.schedule}`;
  }
  if (input.command !== undefined) {
    const command = input.command.trim();
    if (!command || command.length > 500) return "command must be 1-500 characters";
    const parsed = parseCommandLine(command);
    if (!parsed) return "command is empty";
    if (isDangerousCommand(command)) return "command was blocked by the security policy";
    if (!COMMANDS[parsed.name]) return `command '${parsed.name}' is not in the allowlist`;
    if (parsed.name === "cron") return "cron jobs cannot manage cron jobs";
    if (parsed.name === "clear") return "'clear' cannot be used as a cron job";
  }
  return null;
}

export async function listJobs(): Promise<CronJob[]> {
  const storage = await getStorage();
  return (await storage.get<CronJob[]>(JOBS_KEY)) ?? [];
}

export async function getJob(jobId: string): Promise<CronJob | null> {
  const jobs = await listJobs();
  return jobs.find((job) => job.id === jobId) ?? null;
}

export async function createJob(input: CreateJobInput): Promise<Result<CronJob>> {
  const error = validateJobFields(input);
  if (error) return { ok: false, error };

  const job: CronJob = {
    id: randomUUID(),
    name: input.name.trim(),
    schedule: input.schedule,
    command: input.command.trim(),
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
    updatedAt: null,
    lastRunAt: null,
    lastStatus: null,
  };
  const storage = await getStorage();
  const jobs = await listJobs();
  jobs.push(job);
  await storage.set(JOBS_KEY, jobs);
  return { ok: true, value: job };
}

export async function updateJob(jobId: string, patch: JobPatch): Promise<Result<CronJob>> {
  const error = validateJobFields({
    name: patch.name,
    schedule: patch.schedule,
    command: patch.command,
  });
  if (error) return { ok: false, error };

  const storage = await getStorage();
  const jobs = await listJobs();
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) return { ok: false, error: `job '${jobId}' not found` };

  const updated: CronJob = { ...jobs[index], ...patch, updatedAt: Date.now() };
  jobs[index] = updated;
  await storage.set(JOBS_KEY, jobs);
  return { ok: true, value: updated };
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const storage = await getStorage();
  const jobs = await listJobs();
  const remaining = jobs.filter((job) => job.id !== jobId);
  if (remaining.length === jobs.length) return false;
  await storage.set(JOBS_KEY, remaining);
  await storage.delete(`${LOG_PREFIX}${jobId}`);
  return true;
}

export async function getJobLogs(jobId: string): Promise<CronLog[]> {
  const storage = await getStorage();
  return (await storage.get<CronLog[]>(`${LOG_PREFIX}${jobId}`)) ?? [];
}

export async function appendJobLog(jobId: string, log: CronLog): Promise<void> {
  const storage = await getStorage();
  const logs = await getJobLogs(jobId);
  logs.push(log);
  await storage.set(`${LOG_PREFIX}${jobId}`, logs.slice(-LOG_LIMIT));
}
