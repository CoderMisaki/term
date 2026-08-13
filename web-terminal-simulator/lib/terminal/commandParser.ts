export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

export interface SequenceStep {
  command: string;
  /** Operator that preceded this step, or null for the first one. */
  operator: "&&" | "||" | ";" | null;
}

/**
 * Splits a command line on top-level `&&`, `||` and `;` operators while
 * respecting single/double quotes. This is a tiny safe sequencer — it never
 * evaluates anything; it only feeds the command registry.
 */
export function splitSequences(input: string): SequenceStep[] {
  const steps: SequenceStep[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let i = 0;

  const push = (operator: SequenceStep["operator"]) => {
    const trimmed = current.trim();
    if (trimmed) steps.push({ command: trimmed, operator });
    current = "";
  };

  while (i < input.length) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
      i++;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      current += char;
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i++;
      continue;
    }
    if (char === ";") {
      push(";");
      i++;
      continue;
    }
    if (char === "&" || char === "|") {
      const two = input.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        push(two === "&&" ? "&&" : "||");
        i += 2;
        continue;
      }
      // A single & or | is passed through to the (non-existent) command,
      // which will produce a "command not found" style error naturally.
      current += char;
      i++;
      continue;
    }
    current += char;
    i++;
  }
  push(null);
  return steps;
}

/**
 * Tokenizes a single command into argv, handling single quotes, double
 * quotes and backslash escapes. Returns null for empty input.
 */
export function parseCommandLine(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (token !== "") {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token !== "") tokens.push(token);

  if (tokens.length === 0) return null;
  return { name: tokens[0], args: tokens.slice(1), raw: trimmed };
}

export const BLOCKED_MESSAGE =
  "term: blocked by security policy — this command is not allowed in the sandboxed (serverless) mode.";

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)?\s+(\/|\/\*|~|\.\s|\.\.\s|home\b|\/home)/i,
  /\bmkfs\b/i,
  /\bfdisk\b|\bparted\b/i,
  /\bdd\s+.*of=\/dev/i,
  /\bshred\b/i,
  /\bchmod\s+(-R\s+)?(777|666)\s+\//i,
  /\bchown\s+-R\s+.*\//i,
  /\bsudo\b|\bsu\s+[-]?/i,
  /\bpasswd\b|\buseradd\b|\busermod\b|\bgroupadd\b/i,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\bsystemctl\b|\binit\s+\d/i,
  /\bkill\s+(-9\s+)?1\b|\bkillall\b/i,
  /\b:\(\)\s*\{/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i,
  /\bbase64\b[^|]*\|\s*(ba)?sh\b/i,
  /\bpython\b.*-c\b|\bpython3\b.*-c\b/i,
  /\bnode\s+-e\b|\bperl\s+-e\b|\bphp\s+-r\b/i,
  /\beval\b|\bnew\s+Function\b/i,
  /\bmount\b|\bumount\b|\bswapon\b|\bswapoff\b|\bmkswap\b/i,
  /\blosetup\b|\binsmod\b|\brmmod\b/i,
  /\biptables\b|\bnft\b/i,
  /\/dev\/(sd[a-z]|nvme|hd[a-z]|mem|zero|random|urandom)\b/i,
  /\bapt(-get)?\s+(purge|remove)\s+\w*\s*--?\s*(yes|force)/i,
  /\b>+\s*\/\s*\w*\s*$/i,
];

/** Defense-in-depth: rejects destructive or sandbox-escaping commands. */
export function isDangerousCommand(raw: string): boolean {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized));
}
