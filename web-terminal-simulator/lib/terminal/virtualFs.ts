import type { VDir, VFile, VNode } from "@/lib/terminal/types";

/* ------------------------------------------------------------------ */
/* Path resolution                                                     */
/* ------------------------------------------------------------------ */

export function normalizePath(cwd: string, input: string): string {
  const parts = (input.startsWith("/") ? input : `${cwd}/${input}`).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return "/" + stack.join("/");
}

export function splitPath(path: string): string[] {
  return normalizePath("/", path)
    .split("/")
    .filter((part) => part !== "");
}

/* ------------------------------------------------------------------ */
/* Node access                                                         */
/* ------------------------------------------------------------------ */

export function getNode(fs: VDir, path: string): VNode | null {
  const parts = splitPath(path);
  let node: VNode = fs;
  for (const part of parts) {
    if (node.type !== "dir") return null;
    const child: VNode | undefined = node.children[part];
    if (!child) return null;
    node = child;
  }
  return node;
}

export function getParentDir(fs: VDir, path: string): { parent: VDir; name: string } | null {
  const parts = splitPath(path);
  if (parts.length === 0) return null;
  const name = parts[parts.length - 1];
  let node: VNode = fs;
  for (const part of parts.slice(0, -1)) {
    if (node.type !== "dir") return null;
    const child: VNode | undefined = node.children[part];
    if (!child) return null;
    node = child;
  }
  return node.type === "dir" ? { parent: node, name } : null;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export function mkdir(fs: VDir, path: string, recursive = false): { ok: boolean; error?: string } {
  const parts = splitPath(path);
  if (parts.length === 0) return { ok: false, error: "mkdir: cannot create directory '/': File exists" };
  let node: VNode = fs;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const child: VNode | undefined = node.type === "dir" ? node.children[part] : undefined;
    if (!child) {
      if (!isLast && !recursive) {
        return { ok: false, error: `mkdir: cannot create directory '${path}': No such file or directory` };
      }
      const created: VDir = { type: "dir", children: {} };
      if (node.type !== "dir") return { ok: false, error: `mkdir: cannot create directory '${path}': Not a directory` };
      node.children[part] = created;
      node = created;
      continue;
    }
    if (isLast) {
      return { ok: false, error: `mkdir: cannot create directory '${path}': File exists` };
    }
    node = child;
  }
  return { ok: true };
}

export function writeFile(fs: VDir, path: string, content: string): { ok: boolean; error?: string } {
  const parent = getParentDir(fs, path);
  if (!parent) return { ok: false, error: `touch: cannot touch '${path}': No such file or directory` };
  const existing = parent.parent.children[parent.name];
  if (existing?.type === "dir") {
    return { ok: false, error: `touch: cannot touch '${path}': Is a directory` };
  }
  const file: VFile = { type: "file", content };
  parent.parent.children[parent.name] = file;
  return { ok: true };
}

export function readFile(fs: VDir, path: string): { ok: boolean; content?: string; error?: string } {
  const node = getNode(fs, path);
  if (!node) return { ok: false, error: `cat: ${path}: No such file or directory` };
  if (node.type === "dir") return { ok: false, error: `cat: ${path}: Is a directory` };
  return { ok: true, content: node.content };
}

export function removePath(
  fs: VDir,
  path: string,
  options: { recursive?: boolean } = {},
): { ok: boolean; error?: string } {
  const parent = getParentDir(fs, path);
  if (!parent) {
    return { ok: false, error: `rm: cannot remove '${path}': No such file or directory` };
  }
  const node = parent.parent.children[parent.name];
  if (!node) return { ok: false, error: `rm: cannot remove '${path}': No such file or directory` };
  if (node.type === "dir" && !options.recursive) {
    return { ok: false, error: `rm: cannot remove '${path}': Is a directory` };
  }
  delete parent.parent.children[parent.name];
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

/** Short ANSI-coloured label used by ls. Directories are blue, binaries green. */
export function formatLsLine(name: string, node: VNode): string {
  if (node.type === "dir") return `\x1b[1;34m${name}\x1b[0m`;
  if (node.content.startsWith("#!term-bin")) return `\x1b[1;32m${name}\x1b[0m`;
  return name;
}

/* ------------------------------------------------------------------ */
/* Default root filesystem                                             */
/* ------------------------------------------------------------------ */

export function createRootFs(): VDir {
  const fs: VDir = { type: "dir", children: {} };
  mkdir(fs, "/home/user", true);
  mkdir(fs, "/usr/bin", true);
  mkdir(fs, "/usr/local/bin", true);
  mkdir(fs, "/tmp", true);
  mkdir(fs, "/var/log", true);
  mkdir(fs, "/etc", true);
  writeFile(fs, "/home/user/.profile", "export PS1='\\u@\\h:\\w$ '\nexport EDITOR=vi\n");
  writeFile(
    fs,
    "/etc/motd",
    "Welcome to the term web terminal (virtual shell).\nType 'help' to see available commands.\n",
  );
  writeFile(fs, "/var/log/term.log", "# virtual terminal log\n");
  return fs;
}
