import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";

/**
 * SA-816 (d)1 (sitting 4 folder 6): every NUMERIC column carries the DB backstop `CHECK ("<col>" <> 'NaN')`.
 * NUMERIC accepts 'NaN' and node-pg sends a JS NaN as 'NaN', so without the CHECK one bad bind is stored and then
 * poisons every sum. The CHECK is raw SQL (Prisma does not model it), so nothing but this pin notices a NEW Decimal
 * column that ships without one.
 *
 * Columns come from `Prisma.dmmf` (the generated client: every scalar `Decimal` field, with `@map` / `@@map` resolved
 * through dbName). Coverage comes from the migration folders, in folder order: an `ALTER TABLE "<t>" ... ADD CONSTRAINT
 * "<name>" CHECK ("<col>" <> 'NaN' ...)` covers the column; a later `DROP CONSTRAINT "<name>"` on that table uncovers it.
 * SQL comments are stripped first, so a header that merely QUOTES the statement never counts.
 *
 * To fix a red: add the CHECK in the migration folder that adds the column, e.g.
 *   ALTER TABLE "<t>" ADD CONSTRAINT "<t>_<col>_not_nan" CHECK ("<col>" <> 'NaN'::numeric) NOT VALID;
 * (`node apps/api/scripts/generate-not-nan-checks.mjs` prints the names; never hand-edit an applied folder.)
 * A stale client (no `prisma generate` after a schema change) makes this red or green for the wrong reason.
 */

interface ModelLike {
  name: string;
  dbName?: string | null;
  fields: readonly {
    name: string;
    dbName?: string | null;
    kind: string;
    type: string;
    isList: boolean;
  }[];
}

/** "Table.column" for every scalar, non-list Decimal field. */
export function numericColumns(models: readonly ModelLike[]): string[] {
  const out: string[] = [];
  for (const m of models)
    for (const f of m.fields)
      if (f.kind === "scalar" && f.type === "Decimal" && !f.isList)
        out.push(`${m.dbName ?? m.name}.${f.dbName ?? f.name}`);
  return out.sort();
}

const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/**
 * "Table.column" covered by a not-NaN CHECK after replaying `sqls` in order, statement by statement and action by
 * action: `ADD CONSTRAINT "<n>" CHECK ("<col>" <> 'NaN')` covers; `DROP CONSTRAINT "<n>"`, `DROP [COLUMN] "<col>"`
 * and `DROP TABLE "<t>"` uncover (a column re-added later needs its CHECK again).
 */
export function coveredColumns(sqls: readonly string[]): Set<string> {
  const byName = new Map<string, string>(); // "Table\0constraint" -> "Table.column"
  const forget = (pred: (key: string, col: string) => boolean) => {
    for (const [k, v] of [...byName]) if (pred(k, v)) byName.delete(k);
  };
  const stmtRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"([^"]+)"([\s\S]*?);|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]*);/gi;
  const actionRe =
    /ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(\s*"([^"]+)"\s*<>\s*'NaN'(?:::numeric)?\s*\)|DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"|DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
  for (const raw of sqls) {
    const sql = stripSqlComments(raw);
    let s: RegExpExecArray | null;
    while ((s = stmtRe.exec(sql))) {
      if (s[3] !== undefined) {
        const dropped = new Set(Array.from(s[3].matchAll(/"([^"]+)"/g), (m) => m[1]));
        forget((k) => dropped.has(k.split("\0")[0]));
        continue;
      }
      const [, table, body] = s;
      let a: RegExpExecArray | null;
      while ((a = actionRe.exec(body))) {
        if (a[1] !== undefined) byName.set(`${table}\0${a[1]}`, `${table}.${a[2]}`);
        else if (a[3] !== undefined) byName.delete(`${table}\0${a[3]}`);
        else forget((_k, col) => col === `${table}.${a[4]}`);
      }
    }
  }
  return new Set(byName.values());
}

export function missingNotNanChecks(models: readonly ModelLike[], sqls: readonly string[]) {
  const covered = coveredColumns(sqls);
  return numericColumns(models).filter((c) => !covered.has(c));
}

const MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");
const migrationSqls = () =>
  fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((d) => path.join(MIGRATIONS, d, "migration.sql"))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"));

describe("SA-816 (d)1: every NUMERIC column has a CHECK (col <> 'NaN')", () => {
  const models = Prisma.dmmf.datamodel.models as unknown as ModelLike[];

  it("the schema has Decimal columns to check (never passes vacuously)", () => {
    expect(numericColumns(models).length).toBeGreaterThan(100);
  });

  it("every Decimal column of the schema is covered by a migration folder", () => {
    const missing = missingNotNanChecks(models, migrationSqls()).map(
      (c) => `${c}: NUMERIC column with no CHECK ("<col>" <> 'NaN') in any migration folder`,
    );
    expect(missing).toEqual([]);
  });

  describe("the pin's own fixtures", () => {
    const fixture: ModelLike[] = [
      {
        name: "Thing",
        dbName: "thing_table",
        fields: [
          { name: "id", kind: "scalar", type: "String", isList: false },
          { name: "price", kind: "scalar", type: "Decimal", isList: false },
          { name: "rate", dbName: "rate_col", kind: "scalar", type: "Decimal", isList: false },
          { name: "rates", kind: "scalar", type: "Decimal", isList: true },
        ],
      },
    ];
    const covers = `ALTER TABLE "thing_table"
  ADD CONSTRAINT "thing_table_price_not_nan" CHECK ("price" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "thing_table_rate_col_not_nan" CHECK ("rate_col" <> 'NaN'::numeric) NOT VALID;`;

    it("an unchecked Decimal column fails, named with its mapped table and column", () => {
      expect(missingNotNanChecks(fixture, [])).toEqual([
        "thing_table.price",
        "thing_table.rate_col",
      ]);
      expect(
        missingNotNanChecks(fixture, [
          `ALTER TABLE "thing_table" ADD CONSTRAINT "x" CHECK ("price" <> 'NaN') NOT VALID;`,
        ]),
      ).toEqual(["thing_table.rate_col"]);
    });

    it("a multi-ADD statement covers every column; a scalar list is out of scope", () => {
      expect(missingNotNanChecks(fixture, [covers])).toEqual([]);
    });

    it("a CHECK quoted only in a comment, or on another table, does not count", () => {
      expect(missingNotNanChecks(fixture, [`-- ${covers.replace(/\n/g, "\n-- ")}`])).toHaveLength(
        2,
      );
      expect(missingNotNanChecks(fixture, [covers.replace(/thing_table"/, 'other"')])).toHaveLength(
        2,
      );
    });

    it("a later DROP CONSTRAINT uncovers the column", () => {
      expect(
        missingNotNanChecks(fixture, [
          covers,
          `ALTER TABLE "thing_table" DROP CONSTRAINT "thing_table_price_not_nan";`,
        ]),
      ).toEqual(["thing_table.price"]);
    });

    it("a later DROP COLUMN uncovers it, and a re-add needs its CHECK again", () => {
      const drop = `ALTER TABLE "thing_table" DROP COLUMN "price";`;
      expect(missingNotNanChecks(fixture, [covers, drop])).toEqual(["thing_table.price"]);
      expect(
        missingNotNanChecks(fixture, [
          covers,
          drop,
          `ALTER TABLE "thing_table" ADD COLUMN "price" DECIMAL(10,2);`,
        ]),
      ).toEqual(["thing_table.price"]);
      expect(
        missingNotNanChecks(fixture, [
          covers,
          drop,
          `ALTER TABLE "thing_table" ADD COLUMN "price" DECIMAL(10,2),
  ADD CONSTRAINT "thing_table_price_not_nan" CHECK ("price" <> 'NaN'::numeric) NOT VALID;`,
        ]),
      ).toEqual([]);
    });

    it("a later DROP TABLE uncovers every column of that table only", () => {
      const other = covers.replace(/thing_table"/, 'other"');
      expect(
        missingNotNanChecks(fixture, [
          covers,
          other,
          `DROP TABLE IF EXISTS "thing_table" CASCADE;`,
        ]),
      ).toEqual(["thing_table.price", "thing_table.rate_col"]);
      expect(coveredColumns([covers, other, `DROP TABLE "thing_table";`])).toEqual(
        new Set(["other.price", "other.rate_col"]),
      );
    });
  });
});
