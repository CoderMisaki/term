export interface SetOptions {
  /** Optional expiry in seconds (supported by KV-backed adapters). */
  ttlSeconds?: number;
}

/**
 * Minimal key/value adapter. The terminal and cron systems only rely on
 * this interface, so the active backend (memory, Vercel KV, Vercel Blob or
 * Postgres) can be swapped without touching business logic.
 */
export interface StorageAdapter {
  /** Stable identifier reported to the UI (`memory`, `vercel-kv`, ...). */
  readonly kind: string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** List stored keys that start with the given prefix. */
  list(prefix: string): Promise<string[]>;
}
