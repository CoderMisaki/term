import { env } from "@/lib/config/env";
import { getStorageMode } from "@/lib/storage";
import type { StorageAdapter } from "@/lib/storage/types";
import { findRegistryPackage, resolveWithDependencies, searchRegistry, toPackageInfo } from "@/lib/terminal/packageRegistry";
import type { ShellState } from "@/lib/terminal/types";
import {
  createRootFs,
  formatLsLine,
  getNode,
  mkdir as fsMkdir,
  normalizePath,
  readFile as fsReadFile,
  removePath as fsRemovePath,
  writeFile as fsWriteFile,
} from "@/lib/terminal/virtualFs";

/* ------------------------------------------------------------------ */
/* Context & types                                                     */
/* ------------------------------------------------------------------ */

export interface CommandContext {
  state: ShellState;
  args: string[];
  raw: string;
  /** Mutable server-side history (persisted by the executor afterwards). */
  history: string[];
  sessionId: string;
  storage: StorageAdapter;
  write(text: string): void;
  delay(ms: number): Promise<void>;
  signal: AbortSignal;
  /** True when the command runs from a cron job (stricter policy). */
  isCron: boolean;
}

export type CommandHandler = (ctx: CommandContext) => number | void | Promise<number | void>;

export interface CommandDef {
  description: string;
  usage: string;
  handler: CommandHandler;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(value: string, length: number): string {
  return value.length >= length ? value : value + " ".repeat(length - value.length);
}

function resolveEnv(ctx: CommandContext, value: string): string {
  return value.replace(/\$\{?(\w+)\}?/g, (match, name: string) => ctx.state.env[name] ?? "");
}

async function pause(ctx: CommandContext): Promise<void> {
  await ctx.delay(env.pkgDelayMs);
}

/* ------------------------------------------------------------------ */
/* Built-in commands                                                   */
/* ------------------------------------------------------------------ */

const help: CommandDef = {
  description: "Show this help message",
  usage: "help",
  handler(ctx) {
    ctx.write("\x1b[1;36mAvailable commands\x1b[0m (sandboxed virtual shell):\n\n");
    const names = Object.keys(COMMANDS).sort();
    for (const name of names) {
      const def = COMMANDS[name];
      ctx.write(`  \x1b[1;32m${pad(name, 10)}\x1b[0m ${def.description}\n`);
    }
    ctx.write(
      `\n\x1b[90mMode: ${env.clientMode === "pty" ? "real PTY backend" : "serverless virtual shell"} — see 'vercel', 'storage', 'reset'.\x1b[0m\n`,
    );
    return 0;
  },
};

const clear: CommandDef = {
  description: "Clear the terminal screen",
  usage: "clear",
  handler() {
    return 0;
  },
};

const echo: CommandDef = {
  description: "Print arguments to the standard output",
  usage: "echo [-n] [text...]",
  handler(ctx) {
    const args = ctx.args;
    const noNewline = args[0] === "-n";
    const text = args.slice(noNewline ? 1 : 0).join(" ");
    ctx.write(resolveEnv(ctx, text) + (noNewline ? "" : "\n"));
    return 0;
  },
};

const whoami: CommandDef = {
  description: "Print the current (virtual) user",
  usage: "whoami",
  handler(ctx) {
    ctx.write(`${ctx.state.env.USER ?? env.user}\n`);
    return 0;
  },
};

const date: CommandDef = {
  description: "Print the current date and time",
  usage: "date [-u]",
  handler(ctx) {
    const now = new Date();
    if (ctx.args[0] === "-u") {
      ctx.write(now.toUTCString() + "\n");
    } else {
      ctx.write(now.toString() + "\n");
      ctx.write(now.toISOString() + "\n");
    }
    return 0;
  },
};

const pwd: CommandDef = {
  description: "Print the working directory",
  usage: "pwd",
  handler(ctx) {
    ctx.write(ctx.state.cwd + "\n");
    return 0;
  },
};

const cd: CommandDef = {
  description: "Change the working directory",
  usage: "cd [dir]",
  handler(ctx) {
    const target = ctx.args[0] || ctx.state.env.HOME || "/home/user";
    const path = normalizePath(ctx.state.cwd, target);
    const node = getNode(ctx.state.fs, path);
    if (!node) {
      ctx.write(`cd: no such file or directory: ${target}\n`);
      return 1;
    }
    if (node.type !== "dir") {
      ctx.write(`cd: not a directory: ${target}\n`);
      return 1;
    }
    ctx.state.cwd = path;
    return 0;
  },
};

const ls: CommandDef = {
  description: "List directory contents",
  usage: "ls [-a] [-l] [path...]",
  handler(ctx) {
    const showAll = ctx.args.includes("-a") || ctx.args.includes("-la") || ctx.args.includes("-al");
    const long = ctx.args.includes("-l") || ctx.args.includes("-la") || ctx.args.includes("-al");
    const paths = ctx.args.filter((arg) => !arg.startsWith("-"));
    const targets = paths.length > 0 ? paths : [ctx.state.cwd];

    let anyError = false;
    for (const target of targets) {
      const path = normalizePath(ctx.state.cwd, target);
      const node = getNode(ctx.state.fs, path);
      if (!node) {
        ctx.write(`ls: cannot access '${target}': No such file or directory\n`);
        anyError = true;
        continue;
      }
      if (node.type !== "dir") {
        ctx.write(`${formatLsLine(target, node)}\n`);
        continue;
      }
      if (targets.length > 1) ctx.write(`${path}:\n`);
      const children = Object.entries(node.children).sort(([a], [b]) => a.localeCompare(b));
      if (showAll) ctx.write("\x1b[1;34m.\x1b[0m  \x1b[1;34m..\x1b[0m  ");
      for (const [name, child] of children) {
        if (name.startsWith(".") && !showAll) continue;
        if (long) {
          ctx.write(`${child.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--"}  ${pad(name, 24)}\n`);
        } else {
          ctx.write(`${formatLsLine(name, child)}  `);
        }
      }
      if (!long) ctx.write("\n");
    }
    return anyError ? 1 : 0;
  },
};

const cat: CommandDef = {
  description: "Print file contents",
  usage: "cat [file...]",
  handler(ctx) {
    if (ctx.args.length === 0) {
      ctx.write("cat: missing operand\n");
      return 1;
    }
    let failed = false;
    for (const target of ctx.args) {
      const path = normalizePath(ctx.state.cwd, target);
      const result = fsReadFile(ctx.state.fs, path);
      if (!result.ok) {
        ctx.write(`${result.error}\n`);
        failed = true;
        continue;
      }
      ctx.write(result.content ?? "");
      if (!result.content?.endsWith("\n")) ctx.write("\n");
    }
    return failed ? 1 : 0;
  },
};

const touch: CommandDef = {
  description: "Create empty files",
  usage: "touch [file...]",
  handler(ctx) {
    if (ctx.args.length === 0) {
      ctx.write("touch: missing file operand\n");
      return 1;
    }
    for (const target of ctx.args) {
      const path = normalizePath(ctx.state.cwd, target);
      const result = fsWriteFile(ctx.state.fs, path, "");
      if (!result.ok) ctx.write(`${result.error}\n`);
    }
    return 0;
  },
};

const mkdir: CommandDef = {
  description: "Create directories",
  usage: "mkdir [-p] [dir...]",
  handler(ctx) {
    const recursive = ctx.args.includes("-p");
    const paths = ctx.args.filter((arg) => arg !== "-p");
    if (paths.length === 0) {
      ctx.write("mkdir: missing operand\n");
      return 1;
    }
    let failed = false;
    for (const target of paths) {
      const path = normalizePath(ctx.state.cwd, target);
      const result = fsMkdir(ctx.state.fs, path, recursive);
      if (!result.ok) {
        ctx.write(`${result.error}\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  },
};

const rm: CommandDef = {
  description: "Remove files or directories",
  usage: "rm [-r] [-f] [path...]",
  handler(ctx) {
    const recursive = ctx.args.includes("-r") || ctx.args.includes("-rf") || ctx.args.includes("-fr");
    const force = ctx.args.includes("-f") || ctx.args.includes("-rf") || ctx.args.includes("-fr");
    const paths = ctx.args.filter((arg) => !arg.startsWith("-"));
    if (paths.length === 0) {
      ctx.write("rm: missing operand\n");
      return 1;
    }
    let failed = false;
    for (const target of paths) {
      const path = normalizePath(ctx.state.cwd, target);
      if (path === "/" && recursive) {
        ctx.write("rm: refusing to remove the root directory (sandbox policy)\n");
        failed = true;
        continue;
      }
      const result = fsRemovePath(ctx.state.fs, path, { recursive });
      if (!result.ok) {
        if (!force) {
          ctx.write(`${result.error}\n`);
          failed = true;
        }
      }
    }
    return failed ? 1 : 0;
  },
};

const envCommand: CommandDef = {
  description: "Print or modify the virtual environment",
  usage: "env [KEY=value...]",
  handler(ctx) {
    const assignments = ctx.args.filter((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
    const unsets: string[] = [];
    let i = 0;
    while (i < ctx.args.length) {
      if (ctx.args[i] === "-u" && ctx.args[i + 1]) {
        unsets.push(ctx.args[i + 1]);
        i += 2;
      } else i += 1;
    }
    for (const key of unsets) delete ctx.state.env[key];
    for (const assignment of assignments) {
      const eq = assignment.indexOf("=");
      ctx.state.env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
    if (assignments.length === 0 && unsets.length === 0) {
      const lines = Object.entries(ctx.state.env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`);
      ctx.write(lines.join("\n") + "\n");
    }
    return 0;
  },
};

const history: CommandDef = {
  description: "Show the command history (server-side)",
  usage: "history [-c]",
  handler(ctx) {
    if (ctx.args.includes("-c")) {
      ctx.history.length = 0;
      ctx.write("History cleared.\n");
      return 0;
    }
    ctx.history.forEach((entry, index) => {
      ctx.write(`  ${index + 1}  ${entry}\n`);
    });
    if (ctx.history.length === 0) ctx.write("(empty)\n");
    return 0;
  },
};

/* ------------------------------------------------------------------ */
/* Package manager (serverless registry mode)                          */
/* ------------------------------------------------------------------ */

async function packageInstall(ctx: CommandContext, flavor: "apt" | "pkg"): Promise<number> {
  const name = ctx.args[0];
  if (!name) {
    ctx.write(`Usage: ${flavor} install <package>\n`);
    return 2;
  }
  const target = findRegistryPackage(name);
  if (!target) {
    ctx.write(
      flavor === "apt"
        ? `E: Unable to locate package ${name}\n`
        : `pkg: package '${name}' was not found in the registry\n`,
    );
    return 100;
  }
  if (ctx.state.packages[target.name]) {
    ctx.write(
      flavor === "apt"
        ? `${target.name} is already the newest version (${target.version}).\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`
        : `pkg: ${target.name}@${target.version} is already installed\n`,
    );
    return 0;
  }

  ctx.write("Reading package lists... done\n");
  await pause(ctx);
  ctx.write("Building dependency tree... done\n");
  await pause(ctx);

  const plan = resolveWithDependencies(target.name) ?? [];
  const toInstall = plan.filter((pkg) => !ctx.state.packages[pkg.name]);
  ctx.write(`The following NEW packages will be installed:\n  ${toInstall.map((pkg) => pkg.name).join(" ")}\n`);
  await pause(ctx);

  for (const pkg of toInstall) {
    ctx.write(`Selecting previously unselected package ${pkg.name}.\n`);
    ctx.write(`(Reading database ... 0 files and directories currently installed.)\n`);
    ctx.write(`Preparing to unpack ${pkg.name} (${pkg.version}) ...\n`);
    await pause(ctx);
    ctx.write(`Unpacking ${pkg.name} (${pkg.version}) ...\n`);
    await pause(ctx);
    ctx.write(`Setting up ${pkg.name} (${pkg.version}) ...\n`);

    ctx.state.packages[pkg.name] = toPackageInfo(pkg, Date.now());
    if (!pkg.library) {
      for (const command of pkg.commands) {
        fsWriteFile(
          ctx.state.fs,
          `/usr/bin/${command}`,
          `#!term-bin\nname=${pkg.name}\nversion=${pkg.version}\n`,
        );
      }
    }
    await pause(ctx);
  }

  ctx.write(
    `\n\x1b[33mNote:\x1b[0m ${target.name} was installed as a VIRTUAL package (serverless mode).\n` +
      "No real binary was executed or downloaded. For real tools, deploy MODE 2 (PTY backend).\n",
  );
  return 0;
}

async function packageRemove(ctx: CommandContext): Promise<number> {
  const name = ctx.args[0];
  if (!name) {
    ctx.write("Usage: pkg remove <package>\n");
    return 2;
  }
  const installed = ctx.state.packages[name.toLowerCase()];
  if (!installed) {
    ctx.write(`Package '${name}' is not installed, so not removed\n`);
    return 100;
  }
  ctx.write(`Removing ${installed.name} ...\n`);
  await pause(ctx);
  ctx.write(`Purging configuration files for ${installed.name} ...\n`);
  delete ctx.state.packages[installed.name];
  for (const command of installed.commands) {
    fsRemovePath(ctx.state.fs, `/usr/bin/${command}`, {});
  }
  ctx.write(`${installed.name} removed.\n`);
  return 0;
}

function packageList(ctx: CommandContext): number {
  const entries = Object.values(ctx.state.packages).sort((a, b) => a.name.localeCompare(b.name));
  ctx.write("Desired=Unknown/Install/Remove/Purge/Hold\n");
  ctx.write("| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n");
  ctx.write("|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n");
  ctx.write("||/ Name           Version      Description\n");
  ctx.write("+++-==============-============-=====================================\n");
  for (const pkg of entries) {
    ctx.write(`ii  ${pad(pkg.name, 14)} ${pad(pkg.version, 12)} ${pkg.description}\n`);
  }
  if (entries.length === 0) ctx.write("(no packages installed)\n");
  return 0;
}

function packageSearch(ctx: CommandContext): number {
  const query = ctx.args[0];
  if (!query) {
    ctx.write("Usage: pkg search <query>\n");
    return 2;
  }
  const results = searchRegistry(query);
  if (results.length === 0) {
    ctx.write(`No packages found matching '${query}'.\n`);
    return 0;
  }
  for (const pkg of results) {
    ctx.write(`${pkg.name} - ${pkg.description}\n`);
  }
  return 0;
}

async function packageUpdate(ctx: CommandContext, flavor: "apt" | "pkg"): Promise<number> {
  ctx.write(`Hit:1 http://pkg.term.dev/virtual ${flavor} InRelease\n`);
  await pause(ctx);
  ctx.write("Reading package lists... Done\n");
  ctx.state.lastUpdate = Date.now();
  ctx.write("\x1b[33mVirtual registry refreshed — no network calls were made.\x1b[0m\n");
  return 0;
}

const pkg: CommandDef = {
  description: "Virtual package manager (registry mode)",
  usage: "pkg install|remove|list|search|update [args...]",
  async handler(ctx) {
    const sub = ctx.args[0];
    const args = ctx.args.slice(1);
    switch (sub) {
      case "install":
        return packageInstall({ ...ctx, args }, "pkg");
      case "remove":
        return packageRemove({ ...ctx, args });
      case "list":
        return packageList({ ...ctx, args });
      case "search":
        return packageSearch({ ...ctx, args });
      case "update":
        return packageUpdate({ ...ctx, args }, "pkg");
      default:
        ctx.write(
          "pkg: package manager (virtual registry mode)\n" +
            "  pkg install <name>   install a package from the registry\n" +
            "  pkg remove <name>    uninstall a package\n" +
            "  pkg list             list installed packages\n" +
            "  pkg search <query>   search the registry\n" +
            "  pkg update           refresh the virtual registry\n",
        );
        return sub ? 2 : 0;
    }
  },
};

const apt: CommandDef = {
  description: "APT-style package manager (serverless: aliases pkg)",
  usage: "apt install|list|update|search|remove [args...]",
  async handler(ctx) {
    const sub = ctx.args[0];
    const args = ctx.args.slice(1);
    switch (sub) {
      case "install":
        return packageInstall({ ...ctx, args }, "apt");
      case "remove":
        return packageRemove({ ...ctx, args });
      case "update":
        return packageUpdate({ ...ctx, args }, "apt");
      case "search":
        return packageSearch({ ...ctx, args });
      case "list": {
        const entries = Object.values(ctx.state.packages).sort((a, b) => a.name.localeCompare(b.name));
        ctx.write("Listing... Done\n");
        if (entries.length === 0) ctx.write("(no packages installed)\n");
        for (const pkg of entries) {
          ctx.write(`${pkg.name}/${pkg.version} all [installed]\n`);
        }
        return 0;
      }
      default:
        ctx.write(
          "apt: APT-style package manager\n" +
            "  apt install <name>   install a package (virtual registry)\n" +
            "  apt list             list installed packages\n" +
            "  apt update           refresh package lists\n" +
            "  apt search <query>   search available packages\n" +
            "  apt remove <name>    remove a package\n" +
            "\x1b[33mServerless mode: installs are virtual manifests, not real binaries.\x1b[0m\n",
        );
        return sub ? 2 : 0;
    }
  },
};

/* ------------------------------------------------------------------ */
/* Cron (shell front-end for the cron API)                             */
/* ------------------------------------------------------------------ */

async function cronList(ctx: CommandContext): Promise<number> {
  const { listJobs } = await import("@/lib/cron/scheduler");
  const jobs = await listJobs();
  if (jobs.length === 0) {
    ctx.write("No cron jobs defined. Use: cron add <name> \"<schedule>\" <command>\n");
    return 0;
  }
  ctx.write(`${pad("ID", 10)} ${pad("NAME", 20)} ${pad("SCHEDULE", 18)} ${pad("ENABLED", 8)} LAST RUN\n`);
  for (const job of jobs) {
    const last = job.lastRunAt ? new Date(job.lastRunAt).toISOString().slice(0, 19) : "never";
    ctx.write(`${pad(job.id.slice(0, 8), 10)} ${pad(job.name.slice(0, 20), 20)} ${pad(job.schedule, 18)} ${pad(job.enabled ? "yes" : "no", 8)} ${last} (${job.lastStatus ?? "-"})\n`);
  }
  return 0;
}

async function cronAdd(ctx: CommandContext): Promise<number> {
  const { createJob } = await import("@/lib/cron/scheduler");
  const name = ctx.args[1];
  const schedule = ctx.args[2];
  const command = ctx.args.slice(3).join(" ");
  if (!name || !schedule || !command) {
    ctx.write('Usage: cron add <name> "<cron schedule>" <command...>\nExample: cron add backup "0 3 * * *" echo backup\n');
    return 2;
  }
  const result = await createJob({ name, schedule, command, enabled: true });
  if (!result.ok) {
    ctx.write(`cron: ${result.error}\n`);
    return 1;
  }
  ctx.write(`Cron job created: ${result.value.id} (${result.value.name})\n`);
  return 0;
}

async function cronRemove(ctx: CommandContext): Promise<number> {
  const { deleteJob } = await import("@/lib/cron/scheduler");
  const id = ctx.args[1];
  if (!id) {
    ctx.write("Usage: cron rm <id>\n");
    return 2;
  }
  const deleted = await deleteJob(id);
  if (!deleted) {
    ctx.write(`cron: job '${id}' not found\n`);
    return 1;
  }
  ctx.write(`Cron job ${id} deleted.\n`);
  return 0;
}

async function cronRun(ctx: CommandContext): Promise<number> {
  const { runJob } = await import("@/lib/cron/runner");
  const id = ctx.args[1];
  if (!id) {
    ctx.write("Usage: cron run <id>\n");
    return 2;
  }
  ctx.write(`Triggering cron job ${id}...\n`);
  const result = await runJob(id, { force: true });
  if (!result.ok) {
    ctx.write(`cron: ${result.error}\n`);
    return 1;
  }
  const log = result.log;
  ctx.write(`Finished with status "${log.status}" (${Math.round(log.finishedAt - log.startedAt)}ms).\n`);
  return log.status === "success" ? 0 : 1;
}

async function cronLogs(ctx: CommandContext): Promise<number> {
  const { getJobLogs } = await import("@/lib/cron/scheduler");
  const id = ctx.args[1];
  if (!id) {
    ctx.write("Usage: cron logs <id>\n");
    return 2;
  }
  const logs = await getJobLogs(id);
  if (logs.length === 0) {
    ctx.write(`No execution logs for job ${id}.\n`);
    return 0;
  }
  for (const log of logs.slice(-10)) {
    const when = new Date(log.startedAt).toISOString();
    ctx.write(`[${when}] ${log.status} (${Math.round(log.finishedAt - log.startedAt)}ms)\n`);
    const preview = log.output.replace(/\n/g, " ").slice(0, 120);
    if (preview) ctx.write(`    ${preview}\n`);
  }
  return 0;
}

const cron: CommandDef = {
  description: "Manage cron jobs",
  usage: "cron list|add|rm|run|logs [args...]",
  async handler(ctx) {
    const sub = ctx.args[0];
    if (ctx.isCron) {
      ctx.write("cron: scheduling jobs from inside a cron job is not allowed.\n");
      return 1;
    }
    switch (sub) {
      case "list":
        return cronList(ctx);
      case "add":
        return cronAdd(ctx);
      case "rm":
        return cronRemove(ctx);
      case "run":
        return cronRun(ctx);
      case "logs":
        return cronLogs(ctx);
      default:
        ctx.write(
          "cron: manage scheduled jobs (stored server-side)\n" +
            "  cron list                     list jobs\n" +
            '  cron add <name> "<schedule>" <cmd>   create a job (5-field cron)\n' +
            "  cron rm <id>                  delete a job\n" +
            "  cron run <id>                 trigger a job now\n" +
            "  cron logs <id>                show execution logs\n",
        );
        return sub ? 2 : 0;
    }
  },
};

/* ------------------------------------------------------------------ */
/* Platform info                                                       */
/* ------------------------------------------------------------------ */

const vercel: CommandDef = {
  description: "Show deployment/platform information",
  usage: "vercel",
  async handler(ctx) {
    const storageMode = await getStorageMode();
    ctx.write(
      [
        `Platform:      ${env.isVercel ? "Vercel (serverless functions)" : "Not running on Vercel (local/dev)"}`,
        `Environment:   ${env.vercelEnv ?? "development"}`,
        `Region:        ${env.vercelRegion ?? "n/a"}`,
        `Runtime:       Next.js App Router (Node ${process.version})`,
        `Terminal mode: ${env.clientMode}`,
        `Storage:       ${storageMode}`,
        "",
        env.clientMode === "serverless"
          ? "\x1b[33mHonest note: Vercel functions cannot host an interactive PTY. This shell is a\nvirtual command runner (allowlisted commands + virtual filesystem).\x1b[0m"
          : "Real PTY backend configured — commands run in a real Linux shell.",
        "",
      ].join("\n") + "\n",
    );
    return 0;
  },
};

const storage: CommandDef = {
  description: "Show the active storage backend",
  usage: "storage",
  async handler(ctx) {
    const storageMode = ctx.storage.kind;
    ctx.write(`Storage adapter: ${storageMode}\n`);
    if (storageMode === "memory") {
      ctx.write(
        "\x1b[33mWARNING: in-memory storage — session state and history are ephemeral\n" +
          "and can be lost between serverless invocations. Set STORAGE_DRIVER=vercel-kv\n" +
          "(or POSTGRES_URL / BLOB_READ_WRITE_TOKEN) for persistent storage.\x1b[0m\n",
      );
    } else {
      ctx.write("State, history, packages and cron jobs persist across requests.\n");
    }
    return 0;
  },
};

const reset: CommandDef = {
  description: "Reset the virtual session state",
  usage: "reset",
  handler(ctx) {
    ctx.state.cwd = ctx.state.env.HOME ?? "/home/user";
    ctx.state.fs = createRootFs();
    ctx.state.packages = {};
    ctx.state.lastUpdate = null;
    ctx.write("Session state has been reset (filesystem, packages, environment).\n");
    return 0;
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const COMMANDS: Record<string, CommandDef> = {
  help,
  clear,
  echo,
  whoami,
  date,
  pwd,
  ls,
  cd,
  cat,
  touch,
  mkdir,
  rm,
  env: envCommand,
  history,
  pkg,
  apt,
  cron,
  vercel,
  storage,
  reset,
};

export function getDefaultShellState(): ShellState {
  const user = env.user;
  return {
    cwd: "/home/user",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/user",
      USER: user,
      LOGNAME: user,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      EDITOR: "vi",
    },
    fs: createRootFs(),
    packages: {},
    lastUpdate: null,
    createdAt: Date.now(),
  };
}

export { findRegistryPackage as findPackage };
