import { readFile } from "node:fs/promises";
import { parseUsBankStatement, statementToCsv } from "../src/index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: npm run parse:usbank -- <statement.pdf> [--json]");
  process.exit(1);
}

const statement = await parseUsBankStatement(await readFile(file));
process.stdout.write(json ? JSON.stringify(statement, null, 2) + "\n" : statementToCsv(statement));
for (const account of statement.accounts) {
  const status = account.validation.ok ? "OK" : `FAILED\n  - ${account.validation.issues.join("\n  - ")}`;
  console.error(`${account.name}: ${account.transactions.length} transactions, validation ${status}`);
}
