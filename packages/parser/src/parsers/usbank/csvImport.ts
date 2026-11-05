import { UsBankParseError } from "./parser.js";
import type { IsoDate, Transaction, UsBankStatement } from "./types.js";

export interface CsvImportOptions {
  /** Account the transactions belong to; the CSV doesn't say. */
  accountName?: string;
  accountNumber?: string | null;
}

/** Columns in U.S. Bank's transaction download, matched case-insensitively. Memo is optional. */
const REQUIRED = ["date", "transaction", "name", "amount"] as const;

/** True when the text starts with the header of a U.S. Bank transaction download. */
export function isUsBankCsv(text: string): boolean {
  const [header] = parseCsv(firstLine(text));
  if (!header) return false;
  const names = header.map(normalizeHeader);
  return REQUIRED.every((column) => names.includes(column));
}

/**
 * Reads a U.S. Bank transaction download (Date, Transaction, Name, Memo, Amount) into the same shape as a
 * parsed statement, so it imports and de-duplicates like one. Name becomes the description, with the memo
 * appended. Amounts are already signed (debits negative). Any unreadable row rejects the whole file.
 */
export function parseUsBankCsv(text: string, options: CsvImportOptions = {}): UsBankStatement {
  const [header, ...records] = parseCsv(text.replace(/^﻿/, "")).filter((r) => r.some((cell) => cell.trim()));
  if (!header) throw new UsBankParseError("The file is empty");

  const names = header.map(normalizeHeader);
  const missing = REQUIRED.filter((column) => !names.includes(column));
  if (missing.length) throw new UsBankParseError("Not a U.S. Bank transaction download", [`Missing columns: ${missing.join(", ")}`]);
  const col = (record: string[], name: string) => (record[names.indexOf(name)] ?? "").trim();

  const transactions: Transaction[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  records.forEach((record, i) => {
    const row = i + 2; // 1-based, after the header
    const date = parseDate(col(record, "date"));
    const amount = parseAmount(col(record, "amount"));
    const kind = col(record, "transaction").toUpperCase();
    const name = col(record, "name");
    if (!date) errors.push(`Row ${row}: unreadable date "${col(record, "date")}"`);
    if (amount === null) errors.push(`Row ${row}: unreadable amount "${col(record, "amount")}"`);
    if (!name) errors.push(`Row ${row}: no name`);
    if (!date || amount === null || !name) return;

    if ((kind === "DEBIT" && amount > 0) || (kind === "CREDIT" && amount < 0)) {
      warnings.push(`Row ${row}: ${kind} with amount ${amount.toFixed(2)}; kept the amount's sign`);
    }
    const memo = cleanMemo(names.includes("memo") ? col(record, "memo") : "");
    transactions.push({
      date,
      section: amount < 0 ? "Debits" : "Credits",
      type: kind || (amount < 0 ? "DEBIT" : "CREDIT"),
      description: memo ? `${name} ${memo}` : name,
      details: [],
      refNumber: null,
      amount,
      transactionDate: null,
      cardLast4: null,
      page: 0,
    });
  });

  if (errors.length) throw new UsBankParseError("Couldn't read some rows", errors);
  if (transactions.length === 0) throw new UsBankParseError("The file has no transactions");

  const dates = transactions.map((t) => t.date).sort();
  const credits = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const debits = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const accountNumber = options.accountNumber ?? null;
  return {
    bank: "U.S. Bank",
    accountNumber,
    period: { start: dates[0]!, end: dates[dates.length - 1]! },
    customerLines: [],
    accounts: [
      {
        name: options.accountName ?? "Transaction download",
        accountNumber,
        summary: { beginningBalance: null, endingBalance: null, daysInPeriod: null, averageBalance: null, lines: [], details: [] },
        transactions,
        sectionTotals: { Credits: round2(credits), Debits: round2(debits) },
        dailyBalances: [],
        validation: { ok: warnings.length === 0, issues: warnings },
      },
    ],
  };
}

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const firstLine = (text: string) => text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
const normalizeHeader = (h: string) => h.trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `2026-10-21`, or `10/21/2026` as older downloads write it. */
function parseDate(value: string): IsoDate | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [y, mo, d] = m ? [m[1]!, m[2]!, m[3]!] : (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)) ? [m[3]!, m[1]!, m[2]!] : [];
  if (!y || !mo || !d) return null;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso) ? iso : null;
}

/** `-107.40`, `2706.36`, and tolerates `$1,234.56`. */
function parseAmount(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return round2(Number(cleaned));
}

/** Drops the "Download from usbank.com." boilerplate and empty "; ; ;" segments some downloads include. */
function cleanMemo(memo: string): string {
  return memo
    .replace(/^download from usbank\.com\.?/i, "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");
}
