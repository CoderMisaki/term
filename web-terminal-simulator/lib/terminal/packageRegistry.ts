import type { PackageInfo } from "@/lib/terminal/types";

export interface RegistryPackage {
  name: string;
  version: string;
  description: string;
  commands: string[];
  dependencies: string[];
  /** True for virtual library packages (no binaries, only deps). */
  library?: boolean;
}

/**
 * Virtual package registry. In SERVERLESS mode the package manager never
 * downloads or executes anything — it installs manifest entries and virtual
 * bin stubs into the sandboxed filesystem. Real binaries require MODE 2
 * (PTY backend on a real Linux container/VPS).
 */
export const PACKAGE_REGISTRY: RegistryPackage[] = [
  { name: "git", version: "2.47.1", description: "fast, scalable, distributed revision control system", commands: ["git"], dependencies: [] },
  { name: "curl", version: "8.10.1", description: "command line tool for transferring data with URL syntax", commands: ["curl"], dependencies: ["libc6"] },
  { name: "wget", version: "1.24.5", description: "retrieves files from the web", commands: ["wget"], dependencies: ["libc6"] },
  { name: "jq", version: "1.7.1", description: "lightweight and flexible command-line JSON processor", commands: ["jq"], dependencies: ["libc6"] },
  { name: "vim", version: "9.1.0", description: "Vi IMproved - enhanced text editor", commands: ["vim", "vi"], dependencies: ["ncurses"] },
  { name: "nano", version: "8.1", description: "small, friendly text editor inspired by Pico", commands: ["nano"], dependencies: ["ncurses"] },
  { name: "htop", version: "3.3.0", description: "interactive process viewer", commands: ["htop"], dependencies: ["ncurses"] },
  { name: "tmux", version: "3.5a", description: "terminal multiplexer", commands: ["tmux"], dependencies: ["ncurses"] },
  { name: "ripgrep", version: "14.1.1", description: "recursively searches directories for a regex pattern", commands: ["rg"], dependencies: ["libc6"] },
  { name: "fd", version: "10.2.0", description: "simple, fast and user-friendly alternative to find", commands: ["fd"], dependencies: ["libc6"] },
  { name: "tree", version: "2.1.1", description: "displays an indented directory tree", commands: ["tree"], dependencies: ["libc6"] },
  { name: "python3", version: "3.12.7", description: "interactive high-level object-oriented language", commands: ["python3", "python"], dependencies: ["libc6"] },
  { name: "nodejs", version: "22.11.0", description: "evented I/O for V8 javascript", commands: ["node", "npm", "npx"], dependencies: ["libuv"] },
  { name: "yarn", version: "1.22.22", description: "fast, reliable, and secure dependency management", commands: ["yarn"], dependencies: ["nodejs"] },
  { name: "ffmpeg", version: "7.1", description: "tools for transcoding, streaming and playing multimedia", commands: ["ffmpeg", "ffprobe"], dependencies: ["libc6"] },
  { name: "imagemagick", version: "6.9.13-16", description: "image manipulation programs", commands: ["convert", "identify"], dependencies: ["libc6"] },
  { name: "openssh-client", version: "9.9p1", description: "secure shell client programs", commands: ["ssh", "scp", "sftp"], dependencies: ["openssl"] },
  { name: "zsh", version: "5.9", description: "shell with lots of features", commands: ["zsh"], dependencies: ["ncurses"] },
  { name: "fish", version: "3.7.1", description: "friendly interactive shell", commands: ["fish"], dependencies: ["ncurses"] },
  { name: "neofetch", version: "7.1.0", description: "shows system information in a stylish way", commands: ["neofetch"], dependencies: [] },
  { name: "unzip", version: "6.0-28", description: "De-archiver for .zip files", commands: ["unzip"], dependencies: ["libc6"] },
  { name: "tar", version: "1.35", description: "GNU version of the tar archiving utility", commands: ["tar"], dependencies: ["libc6"] },
  // Virtual libraries
  { name: "libc6", version: "2.39-0ubuntu8", description: "GNU C Library: shared libraries (virtual)", commands: [], dependencies: [], library: true },
  { name: "ncurses", version: "6.5", description: "shared libraries for terminal handling (virtual)", commands: [], dependencies: [], library: true },
  { name: "libuv", version: "1.49.1", description: "asynchronous event notification library (virtual)", commands: [], dependencies: [], library: true },
  { name: "openssl", version: "3.3.2", description: "secure sockets layer toolkit (virtual)", commands: [], dependencies: [], library: true },
];

export function findRegistryPackage(name: string): RegistryPackage | undefined {
  return PACKAGE_REGISTRY.find((pkg) => pkg.name === name.toLowerCase());
}

export function searchRegistry(query: string): RegistryPackage[] {
  const q = query.toLowerCase();
  return PACKAGE_REGISTRY.filter(
    (pkg) => pkg.name.includes(q) || pkg.description.toLowerCase().includes(q),
  );
}

/** Converts a registry entry into persisted package info. */
export function toPackageInfo(pkg: RegistryPackage, installedAt: number): PackageInfo {
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    commands: pkg.commands,
    dependencies: pkg.dependencies,
    installedAt,
  };
}

/** Resolves a package plus all (transitive) virtual dependencies, in install order. */
export function resolveWithDependencies(name: string): RegistryPackage[] | null {
  const root = findRegistryPackage(name);
  if (!root) return null;

  const order: RegistryPackage[] = [];
  const seen = new Set<string>();
  const visit = (pkg: RegistryPackage) => {
    for (const dep of pkg.dependencies) {
      const depPkg = findRegistryPackage(dep);
      if (depPkg && !seen.has(depPkg.name)) {
        seen.add(depPkg.name);
        visit(depPkg);
        order.push(depPkg);
      }
    }
  };
  visit(root);
  order.push(root);
  return order;
}
