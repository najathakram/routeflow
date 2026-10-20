/**
 * SA-816 (d)3 / register row 593: node-pg binds a JS NaN as 'NaN' and a NUMERIC column accepts it, so a
 * script that binds a money value into raw SQL must check it finite first. The shared guard is
 * `assertFiniteMoney(value, label)` in scripts/lib/assert-finite-money.cjs.
 *
 * The pin: any file under apps/api/scripts/** or scripts/** that writes a NUMERIC column through raw SQL
 * (an INSERT column list or an UPDATE ... SET target) must import and call `assertFiniteMoney`, or be named
 * in EXEMPT with the reason. The column list is DERIVED from the Prisma schema folder (every `Decimal`
 * field of every model), never a hand list, so a new money column is covered the day it is added.
 *
 * L-202: an exemption that no longer matches a write, or that is redundant because the file now imports the
 * guard, fails too, so the list can only shrink.
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertFiniteMoney } = require("../../../../scripts/lib/assert-finite-money.cjs");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_DIR = path.join(REPO_ROOT, "apps/api/prisma/schema");
const SCRIPT_ROOTS = ["apps/api/scripts", "scripts"];

/** model -> its NUMERIC columns (every `Decimal` field; no @map / @@map exists in the schema). */
function decimalColumnsOf(schemaText: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let model: string | null = null;
  for (const line of schemaText.split("\n")) {
    const m = /^model\s+(\w+)\s*\{/.exec(line);
    if (m) {
      model = m[1];
      out.set(model, new Set());
      continue;
    }
    if (/^\}/.test(line)) {
      model = null;
      continue;
    }
    const c = /^\s+(\w+)\s+Decimal\b/.exec(line);
    if (model && c) out.get(model)?.add(c[1]);
  }
  return out;
}

const INSERT = /INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]*)\)/gi;
const UPDATE =
  /UPDATE\s+"?(\w+)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]{0,1200}?)(?:\bWHERE\b|\bRETURNING\b|`|;|$)/gi;

/** `Model.column` for every NUMERIC column an INSERT column list or an UPDATE SET target names. */
function moneyWritesIn(text: string, decimals: Map<string, Set<string>>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(INSERT)) {
    for (const raw of m[2].split(",")) {
      const col = raw.trim().replace(/"/g, "");
      if (decimals.get(m[1])?.has(col)) found.add(`INSERT ${m[1]}.${col}`);
    }
  }
  for (const m of text.matchAll(UPDATE)) {
    for (const a of m[2].matchAll(/(?:^|,)\s*"?(\w+)"?\s*=(?!=)/g)) {
      if (decimals.get(m[1])?.has(a[1])) found.add(`UPDATE ${m[1]}.${a[1]}`);
    }
  }
  return [...found];
}

const SCRIPT_FILE = /\.(js|mjs|cjs|ts)$/;
function scriptFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scriptFiles(p, acc);
    else if (SCRIPT_FILE.test(e.name)) acc.push(p);
  }
  return acc;
}

const rel = (abs: string) => path.relative(REPO_ROOT, abs).split(path.sep).join("/");

/** Files that match a money write and DO NOT call the guard, each with why that is safe. */
const EXEMPT: Record<string, string> = {
  "scripts/repair-integrity.mjs":
    "RETIRED (row 195): run as a script it refuses in every mode except --list (a static registry, no database), " +
    "so no bind is reachable; importing it is for the B963 specs only.",
  "apps/api/scripts/report-b673-next-delivery-overcharge.mjs":
    "READ-ONLY report: the UPDATE text is a negative test input for its own assertReadOnlySql guard, which refuses " +
    "it; nothing is executed.",
  "apps/api/scripts/stamp-addon-comp.mjs":
    "Binds no money: the BillingEvent INSERT writes amountDelta as the SQL literal NULL (an add-on comp state " +
    "change, SA-788 A5); no Decimal value is bound.",
};

const GUARD_IMPORT =
  /from\s+"[^"]*assert-finite-money\.cjs"|require\("[^"]*assert-finite-money\.cjs"\)/;
const GUARD_CALL = /\bassertFiniteMoney\(/;

describe("SA-816 (d)3: scripts that bind money into raw SQL call assertFiniteMoney first", () => {
  const decimals = decimalColumnsOf(
    fs
      .readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(".prisma"))
      .map((f) => fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8"))
      .join("\n"),
  );
  const scripts = SCRIPT_ROOTS.flatMap((r) => scriptFiles(path.join(REPO_ROOT, r))).map((abs) => {
    const text = fs.readFileSync(abs, "utf8");
    return { rel: rel(abs), text, writes: moneyWritesIn(text, decimals) };
  });
  const writers = scripts.filter((s) => s.writes.length > 0);

  it("derives the NUMERIC columns from the schema folder (sanity: the known money columns are in)", () => {
    expect(decimals.size).toBeGreaterThan(100);
    for (const [model, col] of [
      ["InvoiceItem", "categoryTaxAmount"],
      ["InvoiceItem", "taxRate"],
      ["Invoice", "total"],
      ["Invoice", "taxAmount"],
      ["OrderItem", "categoryTaxAmount"],
      ["InvoicePayment", "amount"],
      ["Product", "currentStock"],
    ]) {
      expect(decimals.get(model)?.has(col)).toBe(true);
    }
  });

  it("the detector finds INSERT column lists and UPDATE SET targets, and ignores non-money columns", () => {
    expect(
      moneyWritesIn(
        'INSERT INTO "InvoiceItem" (id, "categoryTaxAmount", description) VALUES ($1, $2, $3)',
        decimals,
      ),
    ).toEqual(["INSERT InvoiceItem.categoryTaxAmount"]);
    expect(
      moneyWritesIn(
        'UPDATE "Invoice" SET status = $2, "taxAmount" = $3, "updatedAt" = now() WHERE id = $1',
        decimals,
      ),
    ).toEqual(["UPDATE Invoice.taxAmount"]);
    expect(
      moneyWritesIn('UPDATE "AdvancePayment" SET balance = balance + $2 WHERE id = $1', decimals),
    ).toEqual(["UPDATE AdvancePayment.balance"]);
    expect(
      moneyWritesIn('UPDATE "User" SET password = $1, "updatedAt" = now() WHERE id = $2', decimals),
    ).toEqual([]);
    expect(moneyWritesIn('SELECT "categoryTaxAmount" FROM "InvoiceItem"', decimals)).toEqual([]);
    // an aliased UPDATE (cf. apps/api/scripts/backfill-invoiceitem-tenantid.mjs) is still seen, with or without AS
    expect(
      moneyWritesIn(
        'UPDATE "InvoiceItem" ii SET "categoryTaxAmount" = $2 WHERE ii.id = $1',
        decimals,
      ),
    ).toEqual(["UPDATE InvoiceItem.categoryTaxAmount"]);
    expect(
      moneyWritesIn('UPDATE "InvoiceItem" AS ii SET "taxRate" = $2 WHERE ii.id = $1', decimals),
    ).toEqual(["UPDATE InvoiceItem.taxRate"]);
    expect(
      moneyWritesIn('UPDATE "InvoiceItem" ii SET "tenantId" = $2 WHERE ii.id = $1', decimals),
    ).toEqual([]);
  });

  it("finds the known raw-SQL money writers (a scan that matches nothing proves nothing)", () => {
    const known = [
      "apps/api/scripts/backfill-b294-order-line-taxrate.mjs",
      "scripts/repair-f03.mjs",
      "scripts/repair-f10-reopen-damage.mjs",
      "scripts/repair-integrity.mjs",
    ];
    const names = writers.map((w) => w.rel);
    for (const k of known) expect(names).toContain(k);
  });

  it("every writer imports and calls assertFiniteMoney, or is exempt with a reason", () => {
    const unguarded = writers
      .filter((w) => !(GUARD_IMPORT.test(w.text) && GUARD_CALL.test(w.text)))
      .filter((w) => !(w.rel in EXEMPT))
      .map((w) => `${w.rel} (${w.writes.join(", ")})`);
    expect(unguarded).toEqual([]);
  });

  it("an exemption still matches a money write, is still unguarded, and carries a reason", () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      const w = writers.find((x) => x.rel === file);
      expect(w?.rel).toBe(file); // stale: the file no longer writes a money column
      expect(w && GUARD_IMPORT.test(w.text)).toBe(false); // redundant: it imports the guard now
      expect(why.length).toBeGreaterThan(40);
    }
  });
});

describe("assertFiniteMoney (scripts/lib/assert-finite-money.cjs)", () => {
  it.each([
    ["a number", 12.5],
    ["zero", 0],
    ["a negative", -3],
    ["a NUMERIC text from pg", "12.50"],
    ["a signed exponent text", "1e3"],
    ["a Decimal-like object", { toFixed: () => "7.25", toString: () => "7.25" }],
  ])("passes %s and returns it unchanged", (_label, value) => {
    expect(assertFiniteMoney(value, "x")).toBe(value);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["undefined (the unquoted camelCase alias case)", undefined],
    ["null", null],
    ["the text 'NaN' (what pg stores for a NUMERIC NaN)", "NaN"],
    ["an empty string", ""],
    ["a blank string", "  "],
    ["non-numeric text", "abc"],
    ["a plain object", {}],
    ["a plain object that prints as a number", { toString: () => "7.25" }],
    ["a one-element array ([5] prints as 5)", [5]],
    ["a string array", ["5"]],
    ["a boolean", true],
  ])("refuses %s and names the label", (_label, value) => {
    expect(() => assertFiniteMoney(value, "InvoiceItem ii-1 categoryTaxAmount")).toThrow(
      /InvoiceItem ii-1 categoryTaxAmount/,
    );
  });

  it("the thrown error is a NonFiniteMoneyError", () => {
    try {
      assertFiniteMoney(NaN, "x");
      throw new Error("did not throw");
    } catch (e) {
      expect((e as Error).name).toBe("NonFiniteMoneyError");
    }
  });
});
