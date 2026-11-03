import { config } from "./config.js";
import { createPool, migrate } from "./db.js";
import { buildServer } from "./server.js";

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
const app = buildServer({ pool, maxUploadBytes: config.maxUploadBytes, allowPurge: config.allowPurge });
if (applied.length) app.log.info({ migrations: applied }, "applied migrations");

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
