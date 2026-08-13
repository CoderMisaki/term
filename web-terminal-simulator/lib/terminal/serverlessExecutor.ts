import { env } from "@/lib/config/env";
import type { StorageAdapter } from "@/lib/storage/types";
import {
  BLOCKED_MESSAGE,
  isDangerousCommand,
  parseCommandLine,
  splitSequences,
} from "@/lib/terminal/commandParser";
import {
  COMMANDS,
  getDefaultShellState,
  type CommandContext,
} from "@/lib/terminal/commandRegistry";
import type { ExecResult, ShellState } from "@/lib/terminal/types";

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with every chunk of output as it is produced (used for SSE streaming). */
  onOutput?: (chunk: string) => void;
  /** Marks the command as running from a cron job (stricter policy). */
  isCron?: boolean;
}

export const HISTORY_LIMIT = 200;
export const COMMAND_LIMIT = 2000;

const stateKey = (sessionId: string) => `term:session:${sessionId}:state`;
const historyKey = (sessionId: string) => `term:session:${sessionId}:history`;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Executes commands inside the virtual shell. Nothing here ever spawns a
 * process: commands are looked up in the allowlisted registry and operate on
 * the in-memory ShellState which is persisted through the StorageAdapter.
 */
export class ServerlessExecutor {
  constructor(private readonly storage: StorageAdapter) {}

  async loadState(sessionId: string): Promise<ShellState> {
    return (await this.storage.get<ShellState>(stateKey(sessionId))) ?? getDefaultShellState();
  }

  async loadHistory(sessionId: string): Promise<string[]> {
    return (await this.storage.get<string[]>(historyKey(sessionId))) ?? [];
  }

  async run(sessionId: string, input: string, options: RunOptions = {}): Promise<ExecResult> {
    const startedAt = performance.now();
    let output = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let rejected = false;

    const write = (text: string) => {
      if (truncated) return;
      let chunk = text;
      const remaining = env.maxOutput - bytes;
      if (chunk.length >= remaining) {
        chunk = chunk.slice(0, remaining);
        truncated = true;
        chunk += "\n\x1b[33m[output truncated — limit reached]\x1b[0m\n";
      }
      bytes += chunk.length;
      output += chunk;
      options.onOutput?.(chunk);
    };

    const delay = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        const timer = setTimeout(finish, ms);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort);
      });

    const [state, history] = await Promise.all([
      this.loadState(sessionId),
      this.loadHistory(sessionId),
    ]);

    const command = input.slice(0, COMMAND_LIMIT);
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        output: "",
        exitCode: 0,
        durationMs: Math.round(performance.now() - startedAt),
        truncated: false,
        timedOut: false,
        rejected: false,
        cwd: state.cwd,
      };
    }

    const steps = splitSequences(command);
    let exitCode = 0;

    try {
      for (const step of steps) {
        const parsed = parseCommandLine(step.command);
        if (!parsed) continue;

        if (isDangerousCommand(step.command)) {
          write(BLOCKED_MESSAGE + "\n");
          exitCode = 126;
          rejected = true;
          break;
        }

        const def = COMMANDS[parsed.name];
        if (!def) {
          write(`${parsed.name}: command not found\n`);
          exitCode = 127;
          break;
        }

        const ctx: CommandContext = {
          state,
          args: parsed.args,
          raw: step.command,
          history,
          sessionId,
          storage: this.storage,
          write,
          delay,
          signal: options.signal ?? new AbortController().signal,
          isCron: options.isCron ?? false,
        };

        const result = await def.handler(ctx);
        exitCode = typeof result === "number" ? result : 0;

        if (step.operator === "&&" && exitCode !== 0) break;
        if (step.operator === "||" && exitCode === 0) break;

        if (options.signal?.aborted) {
          timedOut = true;
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        timedOut = true;
      } else {
        write(`\x1b[31mterm: internal error: ${(error as Error).message}\x1b[0m\n`);
        exitCode = 1;
      }
    }

    if (timedOut) {
      write(`\n\x1b[31m[command terminated — exceeded ${env.timeoutMs}ms timeout]\x1b[0m\n`);
    }

    // Persist history (only non-empty lines) and the possibly-mutated state.
    if (trimmed && !history.includes(trimmed)) history.push(trimmed);
    const historyTail = history.slice(-HISTORY_LIMIT);
    await Promise.all([
      this.storage.set(stateKey(sessionId), state),
      this.storage.set(historyKey(sessionId), historyTail),
    ]);

    return {
      output,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      truncated,
      timedOut,
      rejected,
      cwd: state.cwd,
    };
  }
}
