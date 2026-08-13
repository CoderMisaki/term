import type { SetOptions, StorageAdapter } from "@/lib/storage/types";

/**
 * Vercel KV (Upstash Redis) adapter. Active when KV credentials are present
 * in the environment (KV_REST_API_URL / KV_REST_API_TOKEN, provided by the
 * Vercel KV integration). @vercel/kv JSON-encodes objects on set and
 * decodes them on get, so structured values round-trip automatically.
 */
export class VercelKVStorageAdapter implements StorageAdapter {
  readonly kind = "vercel-kv";

  constructor(private readonly kv: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, options?: { ex?: number }): Promise<unknown>;
    del(...keys: string[]): Promise<unknown>;
    keys(pattern: string): Promise<string[]>;
  }) {}

  async get<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(key);
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
    if (options?.ttlSeconds) {
      await this.kv.set(key, value, { ex: options.ttlSeconds });
    } else {
      await this.kv.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.del(key);
  }

  async list(prefix: string): Promise<string[]> {
    return this.kv.keys(`${prefix}*`);
  }
}
