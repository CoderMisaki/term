import { env } from "@/lib/config/env";
import { MemoryStorageAdapter } from "@/lib/storage/memoryAdapter";
import { PostgresStorageAdapter } from "@/lib/storage/postgresAdapter";
import { VercelBlobStorageAdapter } from "@/lib/storage/vercelBlobAdapter";
import { VercelKVStorageAdapter } from "@/lib/storage/vercelKVAdapter";
import type { StorageAdapter } from "@/lib/storage/types";

type Driver = "memory" | "vercel-kv" | "vercel-blob" | "postgres";

function detectDriver(): Driver {
  if (env.storageDriver) {
    if (["memory", "vercel-kv", "vercel-blob", "postgres"].includes(env.storageDriver)) {
      return env.storageDriver as Driver;
    }
    console.warn(`[term] Unknown STORAGE_DRIVER "${env.storageDriver}", falling back to auto-detection.`);
  }
  if (process.env.KV_REST_API_URL || process.env.KVS_URL || process.env.UPSTASH_REDIS_REST_URL) {
    return "vercel-kv";
  }
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) {
    return "postgres";
  }
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    return "vercel-blob";
  }
  return "memory";
}

let cached: Promise<StorageAdapter> | null = null;

/**
 * Returns the process-wide storage adapter. Providers are imported lazily so
 * the app works (and even bundles) without any Vercel storage credentials —
 * e.g. `@vercel/kv` is only loaded when a KV driver is actually selected.
 */
export function getStorage(): Promise<StorageAdapter> {
  if (!cached) {
    cached = createAdapter();
  }
  return cached;
}

async function createAdapter(): Promise<StorageAdapter> {
  const driver = detectDriver();
  try {
    switch (driver) {
      case "vercel-kv": {
        const { kv } = await import("@vercel/kv");
        return new VercelKVStorageAdapter(kv);
      }
      case "vercel-blob": {
        const blob = await import("@vercel/blob");
        return new VercelBlobStorageAdapter({
          put: blob.put,
          get: blob.get,
          del: blob.del,
          list: blob.list,
        });
      }
      case "postgres": {
        const { sql } = await import("@vercel/postgres");
        // The driver's generic tagged-template type doesn't line up 1:1 with
        // our narrow Sql shape, so bridge it here (verified at runtime by the
        // adapter's usage, which is the same SQL syntax).
        return new PostgresStorageAdapter(sql as unknown as ConstructorParameters<typeof PostgresStorageAdapter>[0]);
      }
      default:
        return new MemoryStorageAdapter();
    }
  } catch (error) {
    console.warn(`[term] Storage driver "${driver}" failed to initialise, falling back to memory.`, error);
    return new MemoryStorageAdapter();
  }
}

export async function getStorageMode(): Promise<string> {
  return (await getStorage()).kind;
}
