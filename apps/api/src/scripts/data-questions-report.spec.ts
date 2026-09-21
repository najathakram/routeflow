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
    opts: { only?: Set<number> | null; cap?: number; timeoutMs?: number },
    log: (l: string) => void,
  ) => Promise<void>;
};
const { QUESTIONS, assertReadOnly, parseOnly, runReport } = lib;

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
      'SELECT 1; DROP TABLE "Order"',
      'WITH x AS (DELETE FROM "Order" RETURNING 1) SELECT 1',
      'UPDATE "Order" SET status = 1',
      'INSERT INTO "Order" DEFAULT VALUES',
    ])
      expect(() => assertReadOnly(w)).toThrow(/non-read-only/);
    // a write keyword inside a quoted identifier or a string literal is not a write
    expect(() => assertReadOnly(`SELECT "update", 'delete' FROM "Order"`)).not.toThrow();
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
    expect(c.seen[c.seen.length - 1]).toBe("ROLLBACK");
    expect(c.seen.filter((s) => /^(BEGIN|COMMIT)/.test(s))).toEqual(["BEGIN READ ONLY"]);
    for (const s of c.seen)
      expect(s).toMatch(
        /^(BEGIN READ ONLY|SET LOCAL statement_timeout|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK|SELECT \* FROM)/,
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

  it("holds no client identifier: no uuid and no credential-shaped URL in the script or the library", () => {
    for (const f of ["data-questions-report.mjs", "lib/data-questions.cjs"]) {
      const src = fs.readFileSync(path.join(__dirname, "../../scripts", f), "utf8");
      expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(src).not.toMatch(/postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`@]+@/);
    }
  });
});
