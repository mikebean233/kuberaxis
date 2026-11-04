import pg from "pg";
import { createPool, migrate } from "../src/db.js";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://kuberaxis:kuberaxis@localhost:5432/kuberaxis";

/**
 * Recreates and migrates a scratch database, or returns null when Postgres isn't reachable. Each test file
 * uses its own database because vitest runs files in parallel.
 */
export async function openTestDatabase(name: string): Promise<pg.Pool | null> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000 });
  try {
    await admin.connect();
    // Recreated every run, so the tests always exercise the migrations as they are now.
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } catch {
    return null;
  } finally {
    await admin.end().catch(() => {});
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  return pool;
}

export const truncateAll = (pool: pg.Pool) =>
  pool.query("TRUNCATE transaction_items, transactions, imports, accounts, category_rules, categories RESTART IDENTITY");
