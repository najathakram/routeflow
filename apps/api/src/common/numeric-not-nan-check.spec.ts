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
 * and `DROP TABLE "<t>"` uncover (a column re-added later needs its CHECK again). Renames RE-MAP, as Postgres does
 * (a CHECK follows its column and its table): `RENAME [COLUMN] "a" TO "b"`, `RENAME TO "<t2>"` (the table) and
 * `RENAME CONSTRAINT "x" TO "y"`.
 */
export function coveredColumns(sqls: readonly string[]): Set<string> {
  type Col = { table: string; column: string };
  const byName = new Map<string, Col>(); // "Table\0constraint" -> its column
  const key = (table: string, name: string) => `${table}\0${name}`;
  const nameOf = (k: string) => k.slice(k.indexOf("\0") + 1);
  const rewrite = (fn: (k: string, v: Col) => [string, Col] | null) => {
    for (const [k, v] of [...byName]) {
      const next = fn(k, v);
      if (next === null) continue;
      byName.delete(k);
      if (next[0] !== "") byName.set(next[0], next[1]);
    }
  };
  const stmtRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"([^"]+)"([\s\S]*?);|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]*);/gi;
  const actionRe = new RegExp(
    [
      /ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(\s*"([^"]+)"\s*<>\s*'NaN'(?:::numeric)?\s*\)/
        .source, // 1, 2
      /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/.source, // 3
      /DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"([^"]+)"/.source, // 4
      /RENAME\s+CONSTRAINT\s+"([^"]+)"\s+TO\s+"([^"]+)"/.source, // 5, 6
      /RENAME\s+(?:COLUMN\s+)?"([^"]+)"\s+TO\s+"([^"]+)"/.source, // 7, 8
      /RENAME\s+TO\s+"([^"]+)"/.source, // 9
    ].join("|"),
    "gi",
  );
  for (const raw of sqls) {
    const sql = stripSqlComments(raw);
    let s: RegExpExecArray | null;
    while ((s = stmtRe.exec(sql))) {
      if (s[3] !== undefined) {
        const dropped = new Set(Array.from(s[3].matchAll(/"([^"]+)"/g), (m) => m[1]));
        rewrite((_k, v) => (dropped.has(v.table) ? ["", v] : null));
        continue;
      }
      const table = s[1];
      let a: RegExpExecArray | null;
      while ((a = actionRe.exec(s[2]))) {
        // Each branch binds what it needs to consts first, so the narrowing of `a` holds inside the callbacks.
        const [, addName, addCol, dropName, dropCol, fromName, toName, fromCol, toCol, toTable] = a;
        if (addName !== undefined) byName.set(key(table, addName), { table, column: addCol });
        else if (dropName !== undefined) byName.delete(key(table, dropName));
        else if (dropCol !== undefined)
          rewrite((_k, v) => (v.table === table && v.column === dropCol ? ["", v] : null));
        else if (fromName !== undefined)
          rewrite((k, v) => (k === key(table, fromName) ? [key(table, toName), v] : null));
        else if (fromCol !== undefined)
          rewrite((k, v) =>
            v.table === table && v.column === fromCol ? [k, { table, column: toCol }] : null,
          );
        else if (toTable !== undefined)
          rewrite((k, v) =>
            v.table === table
              ? [key(toTable, nameOf(k)), { table: toTable, column: v.column }]
              : null,
          );
      }
    }
  }
  return new Set(Array.from(byName.values(), (v) => `${v.table}.${v.column}`));
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

    it("a RENAME COLUMN re-maps the CHECK to the new name (the old name is no longer covered)", () => {
      const renamed = `ALTER TABLE "thing_table" RENAME COLUMN "price" TO "unit_price";`;
      expect(coveredColumns([covers, renamed])).toEqual(
        new Set(["thing_table.unit_price", "thing_table.rate_col"]),
      );
      expect(missingNotNanChecks(fixture, [covers, renamed])).toEqual(["thing_table.price"]);
    });

    it("a table RENAME TO re-maps every CHECK of that table; RENAME CONSTRAINT keeps coverage", () => {
      const moved = `ALTER TABLE "thing_table" RENAME TO "thing_v2";`;
      expect(coveredColumns([covers, moved])).toEqual(
        new Set(["thing_v2.price", "thing_v2.rate_col"]),
      );
      expect(missingNotNanChecks(fixture, [covers, moved])).toEqual([
        "thing_table.price",
        "thing_table.rate_col",
      ]);
      const renamedCk = `ALTER TABLE "thing_table" RENAME CONSTRAINT "thing_table_price_not_nan" TO "p_nn";`;
      const dropOld = `ALTER TABLE "thing_table" DROP CONSTRAINT "thing_table_price_not_nan";`;
      expect(missingNotNanChecks(fixture, [covers, renamedCk, dropOld])).toEqual([]);
      expect(
        missingNotNanChecks(fixture, [
          covers,
          renamedCk,
          `ALTER TABLE "thing_table" DROP CONSTRAINT "p_nn";`,
        ]),
      ).toEqual(["thing_table.price"]);
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
