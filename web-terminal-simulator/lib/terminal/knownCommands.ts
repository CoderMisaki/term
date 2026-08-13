/**
 * Pure client-safe list of the virtual shell's commands. Kept separate from
 * the server registry so the browser bundle never pulls in server modules.
 */
export const KNOWN_COMMANDS = [
  "help",
  "clear",
  "echo",
  "whoami",
  "date",
  "pwd",
  "ls",
  "cd",
  "cat",
  "touch",
  "mkdir",
  "rm",
  "env",
  "history",
  "pkg",
  "apt",
  "cron",
  "vercel",
  "storage",
  "reset",
] as const;
