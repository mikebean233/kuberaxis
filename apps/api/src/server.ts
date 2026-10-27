import multipart from "@fastify/multipart";
import { parseUsBankStatement, UsBankParseError } from "@kuberaxis/parser";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { importStatement } from "./importStatement.js";
import type { ApiError, ImportResult, TransactionRow } from "./types.js";

export interface ServerOptions {
  pool: pg.Pool;
  maxUploadBytes: number;
  allowPurge?: boolean;
  logger?: boolean;
}

export function buildServer({ pool, maxUploadBytes, allowPurge = false, logger = true }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });
  app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });

  app.get("/api/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  app.get("/api/transactions", async (): Promise<TransactionRow[]> => {
    const { rows } = await pool.query<TransactionRow>(
      `SELECT t.id::text AS id, a.id AS "accountId", a.name AS "accountName", a.account_number AS "accountNumber",
              t.posted_date AS "postedDate", t.transaction_date AS "transactionDate", t.section, t.type,
              t.description, t.details, t.ref_number AS "refNumber", t.card_last4 AS "cardLast4",
              (t.amount_cents / 100.0)::float8 AS amount, t.import_id AS "importId"
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       ORDER BY t.posted_date DESC, t.id DESC`,
    );
    return rows;
  });

  app.post("/api/imports", async (request, reply): Promise<ImportResult | ApiError> => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Attach a PDF in the 'file' field" });

    const data = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: "File is too large" });
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return reply.code(415).send({ error: "That file isn't a PDF" });
    }

    let statement;
    try {
      statement = await parseUsBankStatement(data);
    } catch (err) {
      request.log.warn({ err }, "statement parse failed");
      const issues = err instanceof UsBankParseError ? err.issues : [];
      return reply.code(422).send({ error: "Couldn't read this as a U.S. Bank statement", issues });
    }

    return importStatement(pool, statement, { name: file.filename, data });
  });

  if (allowPurge) {
    app.delete("/api/data", async () => {
      await pool.query("TRUNCATE transactions, imports, accounts RESTART IDENTITY");
      return { ok: true };
    });
  }

  return app;
}
