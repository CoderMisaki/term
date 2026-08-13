import type { StorageAdapter } from "@/lib/storage/types";

type BlobApi = {
  put(pathname: string, body: string, options: {
    access: "private";
    addRandomSuffix?: boolean;
    allowOverwrite?: boolean;
    contentType?: string;
  }): Promise<{ pathname: string }>;
  get(pathname: string, options: { access: "private"; useCache?: boolean }): Promise<{ stream: ReadableStream<Uint8Array> | null } | null>;
  del(pathname: string): Promise<void>;
  list(options: { prefix?: string; limit?: number }): Promise<{ blobs: { pathname: string }[] }>;
};

/**
 * Vercel Blob adapter. Blob is object storage for files — it is NOT a
 * key/value store, so this adapter is intentionally used only for
 * coarse-grained data (state snapshots, execution logs, backups).
 * Every set() overwrites a single JSON blob per key; reads fetch it back.
 *
 * Prefer the KV adapter for hot session state. This adapter exists so the
 * app still works when only BLOB_READ_WRITE_TOKEN is configured.
 */
export class VercelBlobStorageAdapter implements StorageAdapter {
  readonly kind = "vercel-blob";

  private static readonly ROOT = "term-state";

  constructor(private readonly blob: BlobApi) {}

  private path(key: string): string {
    return `${VercelBlobStorageAdapter.ROOT}/${key}.json`;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.blob.get(this.path(key), { access: "private", useCache: false });
    if (!result?.stream) return null;
    const text = await new Response(result.stream).text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.blob.put(this.path(key), JSON.stringify(value), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  }

  async delete(key: string): Promise<void> {
    await this.blob.del(this.path(key)).catch(() => undefined);
  }

  async list(prefix: string): Promise<string[]> {
    const result = await this.blob.list({ prefix: `${VercelBlobStorageAdapter.ROOT}/${prefix}`, limit: 1000 });
    return result.blobs.map((b) => b.pathname.slice(VercelBlobStorageAdapter.ROOT.length + 1).replace(/\.json$/, ""));
  }
}
