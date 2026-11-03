import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// Return DATE columns as "YYYY-MM-DD" strings instead of local-midnight Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
/** Arbitrary constant so concurrent server starts don't race applying migrations. */
const MIGRATION_LOCK_ID = 727_001;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** Applies any `migrations/*.sql` files not yet recorded in `schema_migrations`, in filename order. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      newlyApplied.push(file);
    }
    return newlyApplied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
