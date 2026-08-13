export type TerminalMode = "serverless" | "pty";

/* ------------------------------------------------------------------ */
/* Virtual filesystem                                                  */
/* ------------------------------------------------------------------ */

export interface VFile {
  type: "file";
  content: string;
}

export interface VDir {
  type: "dir";
  children: Record<string, VNode>;
}

export type VNode = VFile | VDir;

/* ------------------------------------------------------------------ */
/* Virtual shell state                                                 */
/* ------------------------------------------------------------------ */

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  /** Virtual binaries provided by the package (registered in /usr/bin). */
  commands: string[];
  /** Virtual dependency names, resolved before install. */
  dependencies: string[];
  installedAt: number;
}

export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  fs: VDir;
  packages: Record<string, PackageInfo>;
  /** Timestamp of the last `pkg update` / `apt update`. */
  lastUpdate: number | null;
  createdAt: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  /** Set when the command was rejected by the security policy. */
  rejected: boolean;
  /** Working directory after execution (for prompt updates). */
  cwd: string;
}

export interface TerminalStateSummary {
  mode: TerminalMode;
  storageMode: string;
  cwd: string;
  env: Record<string, string>;
  packages: PackageInfo[];
  history: string[];
  sessionId: string;
  user: string;
  host: string;
  onVercel: boolean;
  timeoutMs: number;
  maxOutput: number;
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

export type CronStatus = "success" | "error" | "timeout" | "rejected" | null;

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression (m h dom mon dow). */
  schedule: string;
  /** The shell command to run (must pass the command allowlist). */
  command: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number | null;
  lastRunAt: number | null;
  lastStatus: CronStatus;
}

export interface CronLog {
  jobId: string;
  status: NonNullable<CronStatus>;
  output: string;
  startedAt: number;
  finishedAt: number;
  error?: string;
}
