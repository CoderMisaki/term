import CronExpressionParser from "cron-parser";

/**
 * Validates a standard 5-field cron expression (minute hour day-of-month
 * month day-of-week). Empty strings and unparseable expressions are invalid.
 */
export function isValidCronSchedule(expression: string): boolean {
  if (typeof expression !== "string" || expression.length === 0 || expression.length > 64) {
    return false;
  }
  // Vercel Cron uses 5-field expressions; cron-parser would also accept
  // partial (3-field) and seconds-based (6-field) forms, so require 5.
  if (expression.trim().split(/\s+/).length !== 5) {
    return false;
  }
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when `now` falls inside the grace window after the most
 * recent scheduled occurrence. Used by /api/cron/trigger, which runs every
 * minute and executes each job whose previous occurrence is within the last
 * ~90 seconds — approximating exactly-once delivery for 1-minute cron jobs.
 *
 * Note: this is a best-effort trigger on Vercel. Cron deliveries can be
 * delayed, so a job may occasionally be skipped or double-fired; verify the
 * current limits/behavior in the Vercel Cron documentation.
 */
export function cronMatchesNow(
  expression: string,
  now: Date = new Date(),
  windowMs = 90_000,
): boolean {
  try {
    const previous = CronExpressionParser.parse(expression, { currentDate: now }).prev();
    return now.getTime() - previous.getTime() < windowMs;
  } catch {
    return false;
  }
}
