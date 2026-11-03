/**
 * Generates test-data/usbank-sample-statement.pdf: a fictional U.S. Bank Uni-Statement whose text is
 * positioned like the real layout, so the parser can be tested end to end without real account data.
 * Every name, address, merchant, reference and amount in it is made up.
 *
 *   npm run sample:usbank -w @kuberaxis/parser
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../../test-data/usbank-sample-statement.pdf", import.meta.url));

const PERIOD = { start: "Dec 9, 2025", end: "Jan 8, 2026", days: 31 };
const STATEMENT_ACCOUNT = "1234";

// ---------------------------------------------------------------------------
// Fictional account data
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random digits so the fixture is reproducible. */
let seed = 20251209;
function digits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    s += String(Math.floor(seed / 65536) % 10);
  }
  return s;
}

interface Row {
  date: string;
  type: string;
  description: string;
  ref?: string;
  /** Cents; negative for withdrawals. */
  amount: number;
  details: string[][];
}

const ach = (date: string, type: string, description: string, cents: number, tail: string): Row => ({
  date,
  type,
  description,
  amount: cents,
  details: [[`REF=${digits(15)}N00`, tail]],
});

const deposits: Row[] = [
  ach("Dec 12", "Electronic Deposit", "From EXAMPLE CORP", 215000, "PAYROLL 0000000001"),
  ach("Dec 15", "Electronic Deposit", "From SAMPLE MUTUAL INS", 41250, "CLAIM 0000000002"),
  ach("Dec 26", "Electronic Deposit", "From EXAMPLE CORP", 215000, "PAYROLL 0000000001"),
  ach("Dec 29", "Electronic Deposit", "From PwP MARKETPLACE", 2399, "REFUND 0000000003"),
  ach("Jan 2", "Electronic Deposit", "From STATE DEPT REV", 31800, "TAX REF 0000000004"),
  ach("Jan 8", "Electronic Deposit", "From EXAMPLE CORP", 215000, "PAYROLL 0000000001"),
];

const CARD = "4321";

/** "Debit Purchase": merchant and city in the description, auth code beneath. */
const pos = (date: string, used: string, merchant: string, cents: number, withRef = false): Row => {
  const auth = digits(6);
  return {
    date,
    type: "Debit Purchase",
    description: merchant,
    ref: withRef ? digits(10) : undefined,
    amount: -cents,
    details: [[auth, `On ${used} SAMPLETERM REF ${auth}`]],
  };
};

/** "Debit Purchase - VISA": city in the description, merchant beneath, ref in its own column. */
const visa = (date: string, used: string, city: string, merchant: string, cents: number): Row => {
  const ref = digits(10);
  return {
    date,
    type: "Debit Purchase - VISA",
    description: `On ${used} ${city}`,
    ref,
    amount: -cents,
    details: [[merchant, `REF # 24000000${digits(5)}${ref}${digits(3)}`]],
  };
};

const cardWithdrawals: Row[] = [
  pos("Dec 9", "120925", "COFFEE CORNER ANYTOWN ST", 640),
  visa("Dec 10", "120925", "ANYTOWN ST", "MAIN ST GROCERY", 8412),
  visa("Dec 10", "120925", "RIVERTON ST", "CORNER GAS #12", 4103),
  pos("Dec 11", "121125", "SAMPLE HARDWARE RIVERTON ST", 2799, true),
  visa("Dec 12", "121125", "LAKEVIEW ST", "BURGER PLACE 042", 1388),
  visa("Dec 14", "121325", "ANYTOWN ST", "PIZZA PALACE #7", 3150),
  visa("Dec 15", "121425", "ANYTOWN ST", "MAIN ST GROCERY", 11265),
  pos("Dec 15", "121525", "BOOK NOOK LAKEVIEW ST", 1999),
  visa("Dec 16", "121525", "RIVERTON ST", "TACO STAND 0815", 1142),
  visa("Dec 17", "121625", "LAKEVIEW ST", "EXAMPLE ELECTRONICS", 129999),
  visa("Dec 18", "121725", "ANYTOWN ST", "COFFEE CORNER", 575),
  visa("Dec 19", "121825", "ANYTOWN ST", "CORNER GAS #12", 3877),
  pos("Dec 19", "121925", "TOY BARN RIVERTON ST", 6450, true),
  visa("Dec 21", "122025", "LAKEVIEW ST", "MAIN ST GROCERY", 15433),
  visa("Dec 22", "122125", "ANYTOWN ST", "BURGER PLACE 042", 1621),
  visa("Dec 23", "122225", "RIVERTON ST", "SAMPLE PHARMACY 9", 2318),
  pos("Dec 23", "122325", "COFFEE CORNER ANYTOWN ST", 690),
  visa("Dec 26", "122425", "ANYTOWN ST", "MAIN ST GROCERY", 9726),
  visa("Dec 28", "122725", "LAKEVIEW ST", "CINEMA 6", 3400),
  visa("Dec 29", "122825", "ANYTOWN ST", "CORNER GAS #12", 4255),
  visa("Dec 30", "122925", "RIVERTON ST", "PIZZA PALACE #7", 2745),
  visa("Dec 31", "123025", "ANYTOWN ST", "PARTY SUPPLY CO", 4812),
  pos("Jan 2", "010226", "SAMPLE HARDWARE RIVERTON ST", 1534),
  visa("Jan 3", "010226", "ANYTOWN ST", "MAIN ST GROCERY", 13077),
  visa("Jan 5", "010326", "LAKEVIEW ST", "TACO STAND 0815", 976),
  visa("Jan 5", "010426", "ANYTOWN ST", "COFFEE CORNER", 525),
  visa("Jan 6", "010526", "RIVERTON ST", "CORNER GAS #12", 3990),
  pos("Jan 7", "010726", "BOOK NOOK LAKEVIEW ST", 1250),
  visa("Jan 8", "010726", "ANYTOWN ST", "MAIN ST GROCERY", 7718),
];

const p2p = (date: string, merchant: string, cents: number): Row =>
  ach(date, "Electronic Withdrawal", `To PwP ${merchant}`, -cents, `000000000Sample${digits(8)}`);

const otherWithdrawals: Row[] = [
  p2p("Dec 9", "STREAMFLIX", 1599),
  p2p("Dec 10", "MUSICBOX", 1099),
  ach("Dec 11", "Electronic Withdrawal", "To ANYTOWN UTILITIES", -14210, "UTILITY 0000000005"),
  { date: "Dec 15", type: "Mobile Banking Payment", description: "To Credit Card *************0000", amount: -50000, details: [] },
  p2p("Dec 16", "CLOUD STORAGE", 299),
  { date: "Dec 17", type: "Customer Withdrawal", description: "", ref: "1111111111", amount: -30000, details: [] },
  ach("Dec 18", "Electronic Withdrawal", "To SAMPLE AUTO INS", -9850, "INSURANCE 0000000006"),
  p2p("Dec 21", "MARKETPLACE", 4588),
  ach("Dec 22", "Electronic Withdrawal", "To P2P SERVICE", -4000, "0000000007PAYMENT 0000000008"),
  p2p("Dec 23", "AIRLINE CO", 31240),
  p2p("Dec 28", "MARKETPLACE", 2399),
  ach("Dec 29", "Electronic Withdrawal", "To EXAMPLE WIRELESS", -6500, "PHONE 0000000009"),
  ach("Jan 2", "Electronic Withdrawal", "To EXAMPLE MORTGAGE", -185000, "0000000010LOAN 0000011"),
  p2p("Jan 5", "STREAMFLIX", 1599),
  p2p("Jan 6", "RIDESHARE", 2214),
  ach("Jan 7", "Electronic Withdrawal", "To ANYTOWN INTERNET", -6000, "INTERNET 0000000012"),
];

const SAVINGS_ACCOUNT = "5678";
const savingsDeposits: Row[] = [{ date: "Jan 8", type: "Interest Paid", description: "", ref: "0800000000", amount: 8, details: [] }];
const savingsWithdrawals: Row[] = [
  { date: "Dec 18", type: "Customer Withdrawal", description: "", ref: "2222222222", amount: -50000, details: [] },
  ach("Dec 30", "Electronic Withdrawal", "To EXAMPLE BROKERAGE", -25000, "0000000013MONEYLINE SAMPLE"),
];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Item = [x: number, y: number, str: string];
const pages: Item[][] = [];
let items: Item[] = [];
let y = 0;
/** Pages that carry the "Page N of M" header; the disclosures page does not. */
const numbered: Item[][] = [];

const ROW = 10.4;
const BOTTOM = 30;
const AMOUNT_RIGHT = 589;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Helvetica advance widths (per 1000 units) for the characters amounts use. */
const amountWidth = (s: string, size = 8) =>
  ([...s].reduce((w, c) => w + (c === "," || c === "." ? 278 : c === "-" ? 333 : c === "$" ? 556 : 556), 0) * size) / 1000;
const money = (cents: number) =>
  `${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}${cents < 0 ? "-" : ""}`;
const right = (str: string, rightX = AMOUNT_RIGHT): Item => [rightX - amountWidth(str), y, str];

const text = (x: number, str: string) => items.push([x, y, str]);
const line = (...cells: (Item | [number, string])[]) => {
  for (const c of cells) items.push(c.length === 3 ? c : [c[0], y, c[1]]);
  y -= ROW;
};

function newPage(isNumbered = true) {
  items = [];
  pages.push(items);
  if (isNumbered) numbered.push(items);
  y = 762;
  text(72, "SAMPLE STATEMENT - FICTIONAL DATA FOR TESTING");
  text(514.8, "Uni-Statement");
  y = 749.3;
  text(526.6, "Account Number:");
  y = 737.3;
  text(528.5, STATEMENT_ACCOUNT);
  y = 726.3;
  text(524, "Statement Period:");
  y = 713.2;
  text(542.5, PERIOD.start);
  y = 701.2;
  text(565.6, "through");
  y = 689.1;
  text(549.6, PERIOD.end);
  y = 665.1;
  text(550, "Page {n} of {total}");
}

interface Account {
  name: string;
  number: string;
  numberSeparate?: boolean;
}

function continuedHeader(account: Account, heading?: string, card?: string) {
  newPage();
  y = 646.8;
  line([20.2, account.name], [516.8, "(CONTINUED)"]);
  accountNumberLine(account);
  y = 624.4;
  if (heading) line([20.1, `${heading} (continued)`]);
  if (card) line([20.2, `Card Number: xxxx-xxxx-xxxx-${card}`]);
}

function accountNumberLine(account: Account) {
  y = 637.5;
  if (account.numberSeparate) line([20.1, "U.S. Bank National Association"], [452.1, "Account Number"], [527, account.number]);
  else line([20.1, "U.S. Bank National Association"], [452.1, `Account Number ${account.number}`]);
}

const tableHeader = () => line([20.2, "Date"], [56.2, "Description of Transaction"], [409, "Ref Number"], [557.9, "Amount"]);

function section(account: Account, heading: string, rows: Row[], card?: string) {
  if (y - 4 * ROW < BOTTOM) continuedHeader(account);
  y -= 7;
  line([20.1, heading]);
  if (card) line([20.2, `Card Number: xxxx-xxxx-xxxx-${card}`]);
  tableHeader();
  rows.forEach((row, i) => {
    if (y - ROW * (1 + row.details.length) < BOTTOM) {
      continuedHeader(account, heading, card);
      tableHeader();
    }
    const cells: (Item | [number, string])[] = [[20.2, row.date], [56.2, row.type]];
    if (row.description) cells.push([207.4, row.description]);
    if (row.ref) cells.push([409, row.ref]);
    if (i === 0) cells.push([495.4, "$"]);
    cells.push(right(money(row.amount)));
    line(...cells);
    for (const detail of row.details) line([70.6, detail[0]!], ...detail.slice(1).map((d, j): [number, string] => [221.8 + j * 100, d]));
  });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (y - 3 * ROW < BOTTOM) continuedHeader(account, heading, card);
  y -= 7;
  if (card) line([312.6, `Card ${card} Withdrawals Subtotal`], [495.4, "$"], right(money(total)));
  line([card ? 352.2 : heading.startsWith("Deposits") ? 351.5 : 348.7, `Total ${heading}`], [495.4, "$"], right(money(total)));
  return total;
}

/** Parses "Dec 9" against the statement period into a sortable key. */
const dateKey = (d: string) => {
  const [mon, day] = d.split(" ");
  const m = MONTHS.indexOf(mon!);
  return (m === 11 ? 2025 : 2026) * 10000 + (m + 1) * 100 + Number(day);
};

function dailyBalances(begin: number, rows: Row[]): [string, number][] {
  const byDate = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => dateKey(a.date) - dateKey(b.date))) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.amount);
  let running = begin;
  return [...byDate].map(([date, delta]) => [date, (running += delta)]);
}

function averageBalance(begin: number, balances: [string, number][]): number {
  let total = 0;
  let current = begin;
  const start = new Date(2025, 11, 9);
  const byKey = new Map(balances.map(([d, b]) => [dateKey(d), b]));
  for (let i = 0; i < PERIOD.days; i++) {
    const day = new Date(start.getTime() + i * 86400000);
    current = byKey.get(day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate()) ?? current;
    total += current;
  }
  return Math.round(total / PERIOD.days);
}

// Page 1: cover
newPage();
y = 734.4;
text(72, "P.O. Box 0000");
y = 726.3;
text(72, "Anytown, ST 00000-0000");
y = 661.6;
let barcode = "";
for (const d of digits(65)) barcode += "ADFT"[Number(d) % 4];
text(72, barcode);
y = 647.5;
for (const name of ["ALEX SAMPLE", "JORDAN SAMPLE", "123 EXAMPLE ST", "ANYTOWN ST 00000-0000"]) line([69.8, name]);
y = 623.3;
line([504.5, "To Contact U.S. Bank"]);
y = 608.2;
line([380.2, "By Phone:"], [532.5, "800-US BANKS"]);
line([380.2, "Internet:"], [547.6, "usbank.com"]);
y = 497.9;
line([20.2, "NEWS FOR YOU"]);
y -= 10;
line([56.2, "This statement is synthetic test data. It does not describe a real person, account or transaction."]);

// Page 2: disclosures (no page number, like the real back page)
newPage(false);
items.length = 0;
y = 770.3;
line([236.2, "BALANCE YOUR ACCOUNT"]);
line([236.2, "To keep track of all your transactions, you should balance your account every month."]);
y = 476.9;
line([16.6, "IMPORTANT DISCLOSURES TO OUR CONSUMER CUSTOMERS"]);
line([16.6, "Placeholder disclosure text for the sample statement."]);

// Checking account
const checking: Account = { name: "U.S. BANK SMARTLY CHECKING", number: STATEMENT_ACCOUNT };
const checkingBegin = 523117;
const checkingRows = [...deposits, ...cardWithdrawals, ...otherWithdrawals];
const checkingBalances = dailyBalances(checkingBegin, checkingRows);
const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.amount, 0);
const checkingEnd = checkingBegin + sum(checkingRows);

newPage();
y = 646.8;
line([20.2, checking.name], [531.6, "Member FDIC"]);
accountNumberLine(checking);
y = 624.4;
line([20.1, "Account Summary"]);
y = 615;
line([20.2, "Beginning Balance on Dec 9"], [193, "$"], right(money(checkingBegin), 293), [315.4, "Number of Days in Statement Period"], right(String(PERIOD.days)));
line([20.2, "Deposits / Credits"], right(money(sum(deposits)), 293), [315.4, "Average Account Balance"], [488.2, "$"], right(money(averageBalance(checkingBegin, checkingBalances))));
line([20.2, "Card Withdrawals"], right(money(sum(cardWithdrawals)), 293));
line([20.2, "Other Withdrawals"], right(money(sum(otherWithdrawals)), 293));
y -= 7;
line([52.3, `Ending Balance on ${PERIOD.end}`], [193, "$"], right(money(checkingEnd), 293));
y -= 8;
line([20.1, "Overdraft Protection"]);
line([20.2, "The following account(s) are linked to your checking account for Overdraft Protection."]);
line([20.2, "1st Position:"], [81.4, `U.S. Bank Standard Savings account ending in ${SAVINGS_ACCOUNT}`]);

section(checking, "Deposits / Credits", deposits);
section(checking, "Card Withdrawals", cardWithdrawals, CARD);
section(checking, "Other Withdrawals", otherWithdrawals);

const perColumn = Math.ceil(checkingBalances.length / 3);
if (y - (perColumn + 4) * ROW < BOTTOM) continuedHeader(checking);
y -= 7;
line([20.1, "Balance Summary"]);
line([20.2, "Date"], [115.5, "Ending Balance"], [207.4, "Date"], [302.7, "Ending Balance"], [394.6, "Date"], [489.9, "Ending Balance"]);
for (let r = 0; r < perColumn; r++) {
  const cells: (Item | [number, string])[] = [];
  [[20.2, 175], [207.4, 362], [394.6, 549]].forEach(([dateX, amountRight], c) => {
    const entry = checkingBalances[c * perColumn + r];
    if (entry) cells.push([dateX!, entry[0]], right(money(entry[1]), amountRight));
  });
  line(...cells);
}
y -= 6;
line([34.6, "Balances only appear for days reflecting change."]);

// Savings account
const savings: Account = { name: "U.S. BANK STANDARD SAVINGS", number: SAVINGS_ACCOUNT, numberSeparate: true };
const savingsBegin = 1000000;
newPage();
y = 646.8;
line([20.1, savings.name], [531.6, "Member FDIC"]);
accountNumberLine(savings);
y = 624.4;
line([20.1, "Account Summary"]);
y = 615;
line([20.1, "Beginning Balance on Dec 9"], [192.9, "$"], right(money(savingsBegin), 293), [315.4, "Annual Percentage Yield Earned"], right("0.01%"));
line([20.1, "Deposits / Credits"], right(money(sum(savingsDeposits)), 293), [315.4, "Interest Earned this Period"], [488.1, "$"], right(money(8)));
line([20.1, "Other Withdrawals"], right(money(sum(savingsWithdrawals)), 293), [315.4, "Interest Paid this Year"], [488.1, "$"], right(money(8)));
line([315.4, "Number of Days in Statement Period"], right(String(PERIOD.days)));
y -= 4;
line([49.8, `Ending Balance on ${PERIOD.end}`], [192.9, "$"], right(money(savingsBegin + sum(savingsDeposits) + sum(savingsWithdrawals)), 293));
section(savings, "Deposits / Credits", savingsDeposits);
section(savings, "Other Withdrawals", savingsWithdrawals);

// Check images: not an account, and must not be parsed as one
const imaged = otherWithdrawals.find((r) => r.type === "Customer Withdrawal")!;
newPage();
y = 646.8;
line([20.1, `IMAGES FOR YOUR ${checking.name} ACCOUNT`], [531.6, "Member FDIC"]);
line([452.1, "Account Number"], [527, STATEMENT_ACCOUNT]);
y = 500.6;
line([20.1, imaged.ref!], [128.2, imaged.date], right(money(-imaged.amount), 272));

// ---------------------------------------------------------------------------
// PDF output (Helvetica, one text object per item)
// ---------------------------------------------------------------------------

for (const [n, page] of numbered.entries()) {
  for (const item of page) item[2] = item[2].replace("{n}", String(n + 1)).replace("{total}", String(numbered.length));
}

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const objects: string[] = [];
const add = (body: string) => objects.push(body);

add("<< /Type /Catalog /Pages 2 0 R >>");
add(""); // pages, filled below
add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
const kids: number[] = [];
for (const page of pages) {
  const stream = page.map(([x, py, str]) => `BT /F1 8 Tf ${x.toFixed(1)} ${py.toFixed(1)} Td (${escape(str)}) Tj ET`).join("\n");
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
  kids.push(objects.length);
}
objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, pdf, "latin1");
console.log(`Wrote ${OUT} (${pages.length} pages)`);
