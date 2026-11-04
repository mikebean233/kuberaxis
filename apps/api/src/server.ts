import multipart from "@fastify/multipart";
import { parseUsBankStatement, UsBankParseError } from "@kuberaxis/parser";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type pg from "pg";
import { importStatement } from "./importStatement.js";
import { CategoryError, categoryUsage, deleteCategory } from "./categories.js";
import { applyRulesToAll, createRule, deleteRule, listRules, previewRule, RuleError, updateRule } from "./categoryRules.js";
import { getTransactionItems, ItemsError, replaceTransactionItems } from "./transactionItems.js";
import type {
  ApiError,
  ApplyRulesResult,
  Category,
  CategoryKind,
  CategoryRule,
  CategoryRuleInput,
  CategoryUsage,
  ImportResult,
  RulePreview,
  TransactionItem,
  TransactionItemInput,
  TransactionRow,
} from "./types.js";

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
              (t.amount_cents / 100.0)::float8 AS amount, t.import_id AS "importId",
              i.item_count AS "itemCount", COALESCE(i.categories, '{}'::text[]) AS categories,
              t.category_id AS "categoryId", tc.name AS "categoryName", t.category_rule_id AS "categoryRuleId",
              CASE WHEN i.item_count > 0 THEN i.allocations
                   ELSE json_build_array(json_build_object('categoryId', t.category_id, 'amount', (t.amount_cents / 100.0)::float8))
              END AS allocations
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories tc ON tc.id = t.category_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS item_count,
                array_agg(DISTINCT c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL) AS categories,
                json_agg(json_build_object('categoryId', ti.category_id, 'amount', (ti.amount_cents / 100.0)::float8)
                         ORDER BY ti.position) AS allocations
         FROM transaction_items ti LEFT JOIN categories c ON c.id = ti.category_id
         WHERE ti.transaction_id = t.id
       ) i
       ORDER BY t.posted_date DESC, t.id DESC`,
    );
    return rows;
  });

  app.get("/api/categories", async (): Promise<Category[]> => {
    const { rows } = await pool.query<Category>("SELECT id, name, kind FROM categories ORDER BY lower(name)");
    return rows;
  });

  // Creating a category that already exists (ignoring case) returns the existing one, unchanged.
  app.post<{ Body: { name: string; kind?: CategoryKind } }>(
    "/api/categories",
    { schema: { body: categoryBodySchema }, attachValidation: true },
    async (request, reply): Promise<Category | ApiError> => {
      if (request.validationError) return reply.code(400).send({ error: request.validationError.message });
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "Give the category a name" });
      const { rows } = await pool.query<Category>(
        `INSERT INTO categories (name, kind) VALUES ($1, $2)
         ON CONFLICT (lower(name)) DO UPDATE SET name = categories.name
         RETURNING id, name, kind`,
        [name, request.body.kind ?? "expense"],
      );
      return rows[0]!;
    },
  );

  app.get("/api/categories/usage", async (): Promise<Record<number, CategoryUsage>> => categoryUsage(pool));

  // Deletes a category; `moveTo` moves its transactions, items and rules to another category first.
  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>(
    "/api/categories/:id",
    { schema: { params: idParamsSchema, querystring: moveToQuerySchema }, attachValidation: true },
    async (request, reply): Promise<{ ok: true } | ApiError> => {
      if (request.validationError) {
        const notFound = request.validationError.validationContext === "params";
        return reply.code(notFound ? 404 : 400).send({ error: notFound ? "Category not found" : request.validationError.message });
      }
      try {
        await deleteCategory(pool, Number(request.params.id), request.query.moveTo ? Number(request.query.moveTo) : null);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof CategoryError)) throw err;
        return reply.code(err.statusCode).send({ error: err.message });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { name: string; kind: CategoryKind } }>(
    "/api/categories/:id",
    { schema: { params: idParamsSchema, body: categoryUpdateBodySchema }, attachValidation: true },
    async (request, reply): Promise<Category | ApiError> => {
      if (request.validationError) {
        const notFound = request.validationError.validationContext === "params";
        return reply.code(notFound ? 404 : 400).send({ error: notFound ? "Category not found" : request.validationError.message });
      }
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "Give the category a name" });
      try {
        const { rows } = await pool.query<Category>("UPDATE categories SET name = $2, kind = $3 WHERE id = $1 RETURNING id, name, kind", [
          request.params.id,
          name,
          request.body.kind,
        ]);
        return rows[0] ?? reply.code(404).send({ error: "Category not found" });
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
        return reply.code(409).send({ error: "Another category already has that name" });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/transactions/:id/items",
    { schema: { params: idParamsSchema }, attachValidation: true },
    async (request, reply): Promise<TransactionItem[] | ApiError> => {
      const items = request.validationError ? null : await getTransactionItems(pool, request.params.id);
      return items ?? reply.code(404).send({ error: "Transaction not found" });
    },
  );

  // Replaces the transaction's items; an empty list removes its itemization.
  app.put<{ Params: { id: string }; Body: { items: TransactionItemInput[] } }>(
    "/api/transactions/:id/items",
    { schema: { params: idParamsSchema, body: itemsBodySchema }, attachValidation: true },
    async (request, reply): Promise<TransactionItem[] | ApiError> => {
      if (request.validationError) {
        const notFound = request.validationError.validationContext === "params";
        return reply.code(notFound ? 404 : 400).send({ error: notFound ? "Transaction not found" : request.validationError.message });
      }
      try {
        return await replaceTransactionItems(pool, request.params.id, request.body.items);
      } catch (err) {
        if (!(err instanceof ItemsError)) throw err;
        return reply.code(err.statusCode).send({ error: err.message, issues: err.issues });
      }
    },
  );

  // Sets the category of a whole transaction by hand (null clears it).
  app.put<{ Params: { id: string }; Body: { categoryId: number | null } }>(
    "/api/transactions/:id/category",
    { schema: { params: idParamsSchema, body: categoryIdBodySchema }, attachValidation: true },
    async (request, reply): Promise<{ categoryId: number | null; categoryName: string | null } | ApiError> => {
      if (request.validationError) {
        const notFound = request.validationError.validationContext === "params";
        return reply.code(notFound ? 404 : 400).send({ error: notFound ? "Transaction not found" : request.validationError.message });
      }
      const { categoryId } = request.body;
      if (categoryId !== null && !(await pool.query("SELECT 1 FROM categories WHERE id = $1", [categoryId])).rowCount) {
        return reply.code(422).send({ error: "That category doesn't exist" });
      }
      const { rows } = await pool.query<{ categoryId: number | null; categoryName: string | null }>(
        `UPDATE transactions t SET category_id = $2, category_rule_id = NULL WHERE t.id = $1
         RETURNING t.category_id AS "categoryId", (SELECT name FROM categories WHERE id = t.category_id) AS "categoryName"`,
        [request.params.id, categoryId],
      );
      return rows[0] ?? reply.code(404).send({ error: "Transaction not found" });
    },
  );

  app.get("/api/rules", async (): Promise<CategoryRule[]> => listRules(pool));

  app.post<{ Body: CategoryRuleInput }>("/api/rules", { schema: { body: ruleBodySchema }, attachValidation: true }, async (request, reply) => {
    if (request.validationError) return reply.code(400).send({ error: request.validationError.message });
    return ruleResponse(reply, () => createRule(pool, request.body));
  });

  app.put<{ Params: { id: string }; Body: CategoryRuleInput }>(
    "/api/rules/:id",
    { schema: { params: idParamsSchema, body: ruleBodySchema }, attachValidation: true },
    async (request, reply) => {
      if (request.validationError) {
        const notFound = request.validationError.validationContext === "params";
        return reply.code(notFound ? 404 : 400).send({ error: notFound ? "Rule not found" : request.validationError.message });
      }
      return ruleResponse(reply, () => updateRule(pool, Number(request.params.id), request.body));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/rules/:id",
    { schema: { params: idParamsSchema }, attachValidation: true },
    async (request, reply): Promise<{ ok: true } | ApiError> => {
      if (!request.validationError && (await deleteRule(pool, Number(request.params.id)))) return { ok: true };
      return reply.code(404).send({ error: "Rule not found" });
    },
  );

  // Shows which transactions a pattern would match, for trying out a rule before saving it.
  app.post<{ Body: Pick<CategoryRuleInput, "matchType" | "pattern" | "direction"> }>(
    "/api/rules/preview",
    { schema: { body: previewBodySchema }, attachValidation: true },
    async (request, reply): Promise<RulePreview | ApiError> => {
      if (request.validationError) return reply.code(400).send({ error: request.validationError.message });
      return ruleResponse(reply, () => previewRule(pool, request.body));
    },
  );

  // Categorizes uncategorized transactions with the rules; `reapply` first clears categories rules set earlier.
  app.post<{ Body: { reapply?: boolean } | undefined }>(
    "/api/rules/apply",
    { schema: { body: applyBodySchema }, attachValidation: true },
    async (request, reply): Promise<ApplyRulesResult | ApiError> => {
      if (request.validationError) return reply.code(400).send({ error: request.validationError.message });
      return applyRulesToAll(pool, { reapply: request.body?.reapply ?? false });
    },
  );

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
      await pool.query("TRUNCATE transaction_items, transactions, imports, accounts RESTART IDENTITY");
      return { ok: true };
    });
  }

  return app;
}

async function ruleResponse<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiError> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    return reply.code(err.statusCode).send({ error: err.message, issues: err.issues });
  }
}

const idParamsSchema = {
  type: "object",
  properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,17}$" } },
  required: ["id"],
} as const;

const moveToQuerySchema = {
  type: "object",
  properties: { moveTo: { type: "string", pattern: "^[1-9][0-9]{0,9}$" } },
  additionalProperties: false,
} as const;

const kindSchema = { enum: ["expense", "income", "transfer"] } as const;

const categoryBodySchema = {
  type: "object",
  properties: { name: { type: "string", maxLength: 100 }, kind: kindSchema },
  required: ["name"],
  additionalProperties: false,
} as const;

const categoryUpdateBodySchema = {
  type: "object",
  properties: { name: { type: "string", maxLength: 100 }, kind: kindSchema },
  required: ["name", "kind"],
  additionalProperties: false,
} as const;

const itemsBodySchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        properties: {
          description: { type: "string", maxLength: 500 },
          amount: { type: "number" },
          categoryId: { type: ["integer", "null"] },
        },
        required: ["description", "amount", "categoryId"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
} as const;

const categoryIdBodySchema = {
  type: "object",
  properties: { categoryId: { type: ["integer", "null"] } },
  required: ["categoryId"],
  additionalProperties: false,
} as const;

const patternProperties = {
  matchType: { enum: ["contains", "regex"] },
  pattern: { type: "string", minLength: 1, maxLength: 500 },
  direction: { enum: ["any", "debit", "credit"] },
} as const;

const previewBodySchema = {
  type: "object",
  properties: patternProperties,
  required: ["matchType", "pattern", "direction"],
  additionalProperties: false,
} as const;

const ruleBodySchema = {
  type: "object",
  properties: {
    ...patternProperties,
    categoryId: { type: "integer" },
    priority: { type: "integer", minimum: -1000000, maximum: 1000000 },
    enabled: { type: "boolean" },
  },
  required: ["matchType", "pattern", "direction", "categoryId", "priority", "enabled"],
  additionalProperties: false,
} as const;

const applyBodySchema = {
  type: ["object", "null"],
  properties: { reapply: { type: "boolean" } },
  additionalProperties: false,
} as const;
