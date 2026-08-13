import type { SetOptions, StorageAdapter } from "@/lib/storage/types";

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * Development adapter. Data lives in the Node process and is lost on
 * restart (and across serverless invocations). It is never used as the
 * "real" storage for a deployed app — the factory prefers KV/Postgres/Blob
 * when credentials are present.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly kind = "memory";

  private readonly store = new Map<string, Entry>();

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.sweep();
    const entry = this.store.get(key);
    if (!entry) return null;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options?.ttlSeconds ? Date.now() + options.ttlSeconds * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.sweep();
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}
