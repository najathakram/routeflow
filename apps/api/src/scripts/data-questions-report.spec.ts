/**
 * data-questions-report (apps/api/scripts): the owner-run READ-ONLY prod report. This spec proves what
 * must never break: every statement is a SELECT, every table/column it names exists in the Prisma schema
 * (the schema is a folder; `Prisma.dmmf` is the generated client), one failing question never hides the
 * others, and the runner only ever issues read-only SQL inside one READ ONLY transaction that ends in a
 * ROLLBACK. Hermetic: no DB, no network, no env; the runner is driven by a fake client.
 * (A stale local Prisma client makes the identifier check red for the wrong reason: `npx prisma generate`.)
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../scripts/lib/data-questions.cjs") as {
  QUESTIONS: {
    n: number;
    bug: string;
    title: string;
    approx: string | null;
    stmts: { label: string; sql: string }[];
  }[];
  assertReadOnly: (sql: string) => void;
  parseOnly: (arg: string | null) => Set<number> | null;
  runReport: (
    client: unknown,
    opts: { only?: Set<number> | null; cap?: number; timeoutMs?: number; lockTimeoutMs?: number },
    log: (l: string) => void,
  ) => Promise<
    { n: number; bug: string; statements: number; rows: number; failed: number; capped: number }[]
  >;
  execute: (
    client: unknown,
    opts: { only?: Set<number> | null; cap?: number },
    log: (l: string) => void,
  ) => Promise<unknown>;
};
const { QUESTIONS, assertReadOnly, parseOnly, runReport, execute } = lib;

const MODELS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind !== "object").map((f) => f.name)),
  ]),
);
const ALL_COLUMNS = new Set([...MODELS.values()].flatMap((s) => [...s]));

/** Identifiers in `sql` that the schema does not have: unknown tables, and `alias."col"` not on the aliased table. */
export function schemaProblems(sql: string): string[] {
  const bad: string[] = [];
  const aliases = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+"(\w+)"\s+(\w+)/g)) {
    if (!MODELS.has(m[1])) bad.push(`unknown table "${m[1]}"`);
    else aliases.set(m[2], (aliases.get(m[2]) ?? new Set()).add(m[1]));
  }
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+"(\w+)"(?!\s+\w)/g))
    if (!MODELS.has(m[1])) bad.push(`unknown table "${m[1]}"`);
  for (const m of sql.matchAll(/\b([a-z]\w*)\."(\w+)"/g)) {
    const models = aliases.get(m[1]);
    if (models && ![...models].some((t) => MODELS.get(t)!.has(m[2])))
      bad.push(`${m[1]}."${m[2]}" is not a column of ${[...models].join("/")}`);
  }
  for (const m of sql.matchAll(/"(\w+)"/g))
    if (!MODELS.has(m[1]) && !ALL_COLUMNS.has(m[1])) bad.push(`unknown identifier "${m[1]}"`);
  return bad;
}

const fakeClient = (
  fail: (sql: string) => boolean = () => false,
  rowsFor: (sql: string) => object[] = () => [],
) => {
  const seen: string[] = [];
  return {
    seen,
    connected: 0,
    ended: 0,
    connect: async function (this: { connected: number }) {
      this.connected++;
    },
    end: async function (this: { ended: number }) {
      this.ended++;
    },
    query: async (sql: string) => {
      seen.push(sql);
      if (fail(sql)) throw new Error(`boom: column does not exist\ndetail line`);
      return { rows: /^SELECT \* FROM/.test(sql) ? rowsFor(sql) : [] };
    },
  };
};

describe("data-questions-report", () => {
  it("has questions 1..16, each with a finding, a title and at least one statement", () => {
    expect(QUESTIONS.map((q) => q.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    for (const q of QUESTIONS) {
      expect(q.bug).toBeTruthy();
      expect(q.title).toBeTruthy();
      expect(q.stmts.length).toBeGreaterThan(0);
      q.stmts.forEach((s) => expect(s.label).toBeTruthy());
    }
  });

  it("every statement is read-only, and the guard refuses writes (mutation cases)", () => {
    QUESTIONS.forEach((q) =>
      q.stmts.forEach((s) => expect(() => assertReadOnly(s.sql)).not.toThrow()),
    );
    for (const w of [
      'DELETE FROM "Order"',
      'WITH x AS (DELETE FROM "Order" RETURNING 1) SELECT 1',
      'UPDATE "Order" SET status = 1',
      'INSERT INTO "Order" DEFAULT VALUES',
    ])
      expect(() => assertReadOnly(w)).toThrow(/non-read-only/);
    // a write keyword inside a quoted identifier or a string literal is not a write
    expect(() => assertReadOnly(`SELECT "update", 'delete' FROM "Order"`)).not.toThrow();
    // CASE ... END is fine: only a statement-level END would be transaction control, and that cannot start a SELECT/WITH
    expect(() => assertReadOnly(`SELECT CASE WHEN 1 = 1 THEN 1 ELSE 0 END`)).not.toThrow();
  });

  it("the guard refuses a second statement on the SEMICOLON itself, and transaction control", () => {
    // fails on the semicolon, not on the DROP that follows it
    expect(() => assertReadOnly("SELECT 1; SELECT 2")).toThrow(/semicolon/);
    expect(() => assertReadOnly('SELECT 1; DROP TABLE "Order"')).toThrow(/semicolon/);
    expect(() => assertReadOnly("SELECT 1;")).toThrow(/semicolon/);
    // a semicolon inside a string literal or a quoted identifier is not a statement separator
    expect(() => assertReadOnly(`SELECT 'a;b', "c;d" FROM "Order"`)).not.toThrow();
    for (const t of [
      "COMMIT",
      "ROLLBACK",
      "SET TRANSACTION READ WRITE",
      "SELECT 1 WHERE (SELECT COMMIT)",
      "WITH x AS (SELECT 1) SELECT * FROM x -- ROLLBACK",
    ])
      expect(() => assertReadOnly(t)).toThrow(/transaction control/);
  });

  it("every table and column named exists in the Prisma schema (and the checker catches a fake one)", () => {
    for (const q of QUESTIONS)
      for (const s of q.stmts)
        expect({ q: q.n, label: s.label, bad: schemaProblems(s.sql) }).toEqual({
          q: q.n,
          label: s.label,
          bad: [],
        });
    expect(schemaProblems(`SELECT i."unitsPerCase" FROM "Invoice" i`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unitsPerCase/)]),
    );
    expect(schemaProblems(`SELECT 1 FROM "NoSuchTable" t`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/NoSuchTable/)]),
    );
  });

  it("--only parsing accepts known question numbers and rejects the rest", () => {
    expect(parseOnly(null)).toBeNull();
    expect([...(parseOnly("7,15") as Set<number>)]).toEqual([7, 15]);
    expect(() => parseOnly("0")).toThrow();
    expect(() => parseOnly("17")).toThrow();
    expect(() => parseOnly("a")).toThrow();
  });

  it("runs in ONE read-only transaction that ends in ROLLBACK and issues no write SQL", async () => {
    const c = fakeClient();
    await runReport(c, { cap: 5, timeoutMs: 1234 }, () => undefined);
    expect(c.seen[0]).toBe("BEGIN READ ONLY");
    expect(c.seen[1]).toBe("SET LOCAL statement_timeout = 1234");
    expect(c.seen[2]).toBe("SET LOCAL lock_timeout = 2000"); // review item 5
    expect(c.seen[c.seen.length - 1]).toBe("ROLLBACK");
    expect(c.seen.filter((s) => /^(BEGIN|COMMIT)/.test(s))).toEqual(["BEGIN READ ONLY"]);
    for (const s of c.seen)
      expect(s).toMatch(
        /^(BEGIN READ ONLY|SET LOCAL (statement|lock)_timeout|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK|SELECT \* FROM)/,
      );
    expect(c.seen.filter((s) => /^SELECT \* FROM/.test(s)).length).toBe(
      QUESTIONS.reduce((n, q) => n + q.stmts.length, 0),
    );
  });

  it("one failing question never hides the others", async () => {
    const c = fakeClient((sql) => sql.includes('FROM "Estimate" e')); // question 1's statements
    const out: string[] = [];
    await runReport(c, {}, (l) => out.push(l));
    const text = out.join("\n");
    expect(text).toMatch(
      /question 1: FAILED \(converted estimates with boxed lines\) boom: column does not exist/,
    );
    expect(text).not.toMatch(/detail line/); // only the first line of the error is printed
    expect(text).toMatch(/== question 2 /);
    expect(text).toMatch(/== question 16 /);
    expect(c.seen.filter((s) => /^ROLLBACK TO SAVEPOINT/.test(s)).length).toBeGreaterThan(0);
    expect(c.seen[c.seen.length - 1]).toBe("ROLLBACK");
  });

  it("--only runs just those questions, and the row cap is honoured", async () => {
    const c = fakeClient(
      () => false,
      () => Array.from({ length: 4 }, (_, i) => ({ tenantId: "t", n: i })),
    );
    const out: string[] = [];
    await runReport(c, { only: new Set([7, 15]), cap: 3 }, (l) => out.push(l));
    const heads = out
      .filter((l) => l.includes("== question"))
      .map((l) => Number(l.match(/question (\d+)/)![1]));
    expect(heads).toEqual([7, 15]);
    expect(out.some((l) => /3\+ rows \(CAPPED\)/.test(l))).toBe(true);
    expect(out.filter((l) => l.startsWith('   {"tenantId"')).length).toBe(
      3 * QUESTIONS.filter((q) => q.n === 7 || q.n === 15).reduce((n, q) => n + q.stmts.length, 0),
    );
  });

  it("returns an id-free summary (question, statements, rows, failures) and keeps ids in the detail log only", async () => {
    const c = fakeClient(
      (sql) => sql.includes('FROM "Estimate" e') && sql.includes("WITH aff"),
      () => [{ tenantId: "tenant-secret-1", productId: "product-secret-2", n: 1 }],
    );
    const out: string[] = [];
    const summary = await runReport(c, { only: new Set([1]) }, (l) => out.push(l));
    expect(summary).toEqual([{ n: 1, bug: "B645", statements: 2, rows: 1, failed: 1, capped: 0 }]);
    expect(JSON.stringify(summary)).not.toMatch(/secret/);
    expect(out.join("\n")).toMatch(/tenant-secret-1/); // the private file keeps them
  });

  it("a failing BEGIN or SET still closes the client and runs no question", async () => {
    for (const bad of ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 30000"]) {
      const c = fakeClient((sql) => sql === bad);
      await expect(execute(c, {}, () => undefined)).rejects.toThrow(/boom/);
      expect(c.connected).toBe(1);
      expect(c.ended).toBe(1);
      expect(c.seen.filter((x) => /^SELECT \* FROM/.test(x))).toEqual([]);
      expect(c.seen.filter((x) => x.startsWith("SAVEPOINT"))).toEqual([]);
    }
  });

  it("a real Postgres rejecting a write inside BEGIN READ ONLY is NOT covered here (needs the *.db.spec.ts lane)", () => {
    // the guard, the fake-client transaction shape and the SQL text are what this hermetic spec can prove
    expect(QUESTIONS.length).toBe(16);
  });

  describe("review-item pins (SQL shape; row semantics need a real DB)", () => {
    const sql = (n: number) => QUESTIONS.find((q) => q.n === n)!.stmts.map((s) => s.sql);
    it("Q12: reversals are aggregated per line BEFORE the sale is joined, never per reversal row", () => {
      for (const t of sql(12)) {
        expect(t).toMatch(/WITH rev AS[\s\S]*GROUP BY 1, 2, 3[\s\S]*sale AS/);
        expect(t).not.toMatch(/JOIN LATERAL/);
      }
      expect(sql(12).some((t) => /sourceOrderItemId/.test(t))).toBe(true); // INLINE keyed to the line
    });
    it("Q13: never relies on deliveredQty IS NOT NULL (NOT NULL DEFAULT 0); buckets are split", () => {
      for (const t of sql(13)) expect(t).not.toMatch(/deliveredQty" IS NOT NULL/);
      expect(sql(13)[0]).toMatch(/deliveredQty" > 0 AND oi."deliveredQty" < oi.qty/);
      expect(sql(13)[1]).toMatch(/deliveredQty" = 0/);
    });
    it("Q1: estimate and invoice lines are summed per product before a 1:1 join", () => {
      const t = sql(1)[1];
      expect(t).toMatch(/WITH aff AS[\s\S]*GROUP BY 1, 2, 3, 4[\s\S]*est AS/);
      expect(t).not.toMatch(
        /JOIN "EstimateItem" ei ON ei."estimateId" = e.id AND ei."productId" = ii."productId"/,
      );
    });
    it("Q16: order lines are tested with EXISTS, never joined (no row multiplication)", () => {
      const t = sql(16)[0];
      expect(t).not.toMatch(/JOIN "OrderItem"/);
      expect(t).toMatch(/EXISTS \(SELECT 1 FROM "OrderItem" oi/);
    });
  });

  it("holds no client identifier: no uuid and no credential-shaped URL in the script or the library", () => {
    for (const f of ["data-questions-report.mjs", "lib/data-questions.cjs"]) {
      const src = fs.readFileSync(path.join(__dirname, "../../scripts", f), "utf8");
      expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(src).not.toMatch(/postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`@]+@/);
    }
  });
});
