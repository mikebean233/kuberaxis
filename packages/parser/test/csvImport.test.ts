import { describe, expect, it } from "vitest";
import { isUsBankCsv, parseCsv, parseUsBankCsv, UsBankParseError } from "../src/index.js";

// Fictional rows in the shape of a U.S. Bank credit card download.
const SAMPLE = [
  '"Date","Transaction","Name","Memo","Amount"',
  '"2026-10-21","DEBIT","GROCERY OUTLET #123","ANYTOWN ST; 24000000000000000000000; 05411; ; ; ;","-107.40"',
  '"2026-10-19","CREDIT","PAYMENT THANK YOU","Download from usbank.com.","2706.36"',
  '"2026-10-18","DEBIT","COFFEE, TEA & CO","","-4.50"',
  "",
].join("\r\n");

const options = { accountName: "U.S. Bank Credit Card" };

describe("parseUsBankCsv", () => {
  it("reads rows as signed transactions with the memo appended to the description", () => {
    const statement = parseUsBankCsv(SAMPLE, options);
    expect(statement.period).toEqual({ start: "2026-10-18", end: "2026-10-21" });
    const [account] = statement.accounts;
    expect(account!.name).toBe("U.S. Bank Credit Card");
    expect(account!.validation).toEqual({ ok: true, issues: [] });
    expect(account!.transactions.map((t) => [t.date, t.type, t.description, t.amount, t.section])).toEqual([
      ["2026-10-21", "DEBIT", "GROCERY OUTLET #123 ANYTOWN ST; 24000000000000000000000; 05411", -107.4, "Debits"],
      ["2026-10-19", "CREDIT", "PAYMENT THANK YOU", 2706.36, "Credits"],
      ["2026-10-18", "DEBIT", "COFFEE, TEA & CO", -4.5, "Debits"],
    ]);
  });

  it("accepts headers in any case and order, without a memo column, and M/D/YYYY dates", () => {
    const statement = parseUsBankCsv("amount,name,date,transaction\n-1.00,THING,3/4/2026,debit\n", options);
    expect(statement.accounts[0]!.transactions[0]).toMatchObject({ date: "2026-03-04", description: "THING", type: "DEBIT", amount: -1 });
  });

  it("warns, but keeps the amount, when its sign disagrees with the Transaction column", () => {
    const statement = parseUsBankCsv("Date,Transaction,Name,Memo,Amount\n2026-10-01,DEBIT,ODD,,5.00\n", options);
    expect(statement.accounts[0]!.transactions[0]!.amount).toBe(5);
    expect(statement.accounts[0]!.validation.issues).toEqual(["Row 2: DEBIT with amount 5.00; kept the amount's sign"]);
  });

  it("rejects the whole file when a row can't be read", () => {
    const bad = "Date,Transaction,Name,Memo,Amount\n2026-10-01,DEBIT,OK,,-1.00\n2026-13-01,DEBIT,X,,abc\n";
    expect(() => parseUsBankCsv(bad, options)).toThrow(UsBankParseError);
    try {
      parseUsBankCsv(bad, options);
    } catch (err) {
      expect((err as UsBankParseError).issues).toEqual(['Row 3: unreadable date "2026-13-01"', 'Row 3: unreadable amount "abc"']);
    }
  });

  it("rejects files without the expected columns or without rows", () => {
    expect(() => parseUsBankCsv("Date,Description,Amount\n", options)).toThrow(/Missing columns: transaction, name/);
    expect(() => parseUsBankCsv("Date,Transaction,Name,Memo,Amount\n", options)).toThrow(/no transactions/);
    expect(() => parseUsBankCsv("", options)).toThrow(/empty/);
  });
});

describe("isUsBankCsv", () => {
  it("recognizes the header, including with a byte-order mark", () => {
    expect(isUsBankCsv(SAMPLE)).toBe(true);
    expect(isUsBankCsv("﻿Date,Transaction,Name,Memo,Amount\n")).toBe(true);
    expect(isUsBankCsv("Account,Date,Amount\n")).toBe(false);
    expect(isUsBankCsv("%PDF-1.7")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded line breaks and a missing final newline", () => {
    expect(parseCsv('a,"b,""c""",d\r\n"line\nbreak",,x')).toEqual([
      ["a", 'b,"c"', "d"],
      ["line\nbreak", "", "x"],
    ]);
  });
});
