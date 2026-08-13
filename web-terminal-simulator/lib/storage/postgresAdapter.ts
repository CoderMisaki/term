import type { StorageAdapter } from "@/lib/storage/types";

type Primitive = string | number | boolean | null | Date | Uint8Array | ArrayBuffer;

type Sql = <O extends { [key: string]: unknown }>(
  strings: TemplateStringsArray,
  ...values: Primitive[]
) => Promise<{ rows: O[] }>;

/**
 * Postgres adapter (@vercel/postgres). Uses a single `term_storage`
 * key/value table created on first use. Active when POSTGRES_URL (or
 * DATABASE_URL) is present in the environment.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  readonly kind = "postgres";

  constructor(private readonly sql: Sql) {}

  private initPromise: Promise<void> | null = null;

  private init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.sql`
        CREATE TABLE IF NOT EXISTS term_storage (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.then(() => undefined);
    }
    return this.initPromise;
  }

  async get<T>(key: string): Promise<T | null> {
    await this.init();
    const result = await this.sql<{ value: string }>`SELECT value FROM term_storage WHERE key = ${key}`;
    const row = result.rows[0];
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO term_storage (key, value) VALUES (${key}, ${JSON.stringify(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }

  async delete(key: string): Promise<void> {
    await this.init();
    await this.sql`DELETE FROM term_storage WHERE key = ${key}`;
  }

  async list(prefix: string): Promise<string[]> {
    await this.init();
    const result = await this.sql<{ key: string }>`SELECT key FROM term_storage WHERE key LIKE ${`${prefix}%`}`;
    return result.rows.map((row) => row.key);
  }
}
