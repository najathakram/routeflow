import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { IMPORT_HISTORY_MODELS } from "../legacy-import/import-history-models";

/**
 * SA-1507 P6 (A2, the STATIC half; DB-10 in `legacy-import/legacy-import-tenant-guard.db.spec.ts` is the live half, and
 * `sitting-s1295-1-check.mjs --post` reads the same sets from the catalogs). Guard presence and the FK set of the six
 * guarded tables (`IMPORT_HISTORY_MODELS`), read from the migration SQL and from `MODEL_DOMAIN` (TypeScript AST of the
 * object literal, never a regex over the .mjs):
 *
 *  1. every guarded table has exactly one
 *     `CREATE TRIGGER "<M>_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "<M>" FOR EACH ROW EXECUTE FUNCTION
 *     "legacy_import_tenant_guard"()`;
 *  2. every `MODEL_DOMAIN` key matching `^Legacy` is in `IMPORT_HISTORY_MODELS` (a new Legacy* table is red until it is
 *     listed and triggered; L-072's list-in-one-place rule);
 *  3. A1-10: the foreign keys whose referencing table is a guarded one are EXACTLY the nine of A1-1, with their actions,
 *     each ON UPDATE NO ACTION; no other `REFERENCES` clause names a guarded table;
 *  4. no `CREATE FUNCTION`, `CREATE TRIGGER` or `CREATE RULE` that names a guarded table, apart from the guard function
 *     and its six triggers.
 *
 * Every rule has a probe in this file that is red on the thing the rule forbids (L-377); each scan asserts that it
 * found the migration it is about (L-389).
 */
const API_DIR = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(API_DIR, "prisma", "migrations");
const SPLIT_SCRIPT = path.join(API_DIR, "scripts", "split-prisma-schema.mjs");
const STAGE1 = "20261126000000_legacy_import_stage1";

const GUARD_FN = "legacy_import_tenant_guard";

interface ExpectedFk {
  table: string;
  cols: string;
  refTable: string;
  refCols: string;
  onDelete: string;
}

/** SA-1507 A1-1, in full. Every one is ON UPDATE NO ACTION. */
export const EXPECTED_FKS: readonly ExpectedFk[] = [
  {
    table: "LegacyImportFile",
    cols: "tenantId,batchId",
    refTable: "LegacyImportBatch",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacyImportIssue",
    cols: "tenantId,batchId",
    refTable: "LegacyImportBatch",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacyImportIssue",
    cols: "tenantId,fileId",
    refTable: "LegacyImportFile",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacySalesDocument",
    cols: "tenantId,batchId",
    refTable: "LegacyImportBatch",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacySalesDocument",
    cols: "tenantId,fileId",
    refTable: "LegacyImportFile",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacySalesLine",
    cols: "tenantId,documentId",
    refTable: "LegacySalesDocument",
    refCols: "tenantId,id",
    onDelete: "CASCADE",
  },
  {
    table: "LegacySalesDocument",
    cols: "customerId",
    refTable: "Customer",
    refCols: "id",
    onDelete: "SET NULL",
  },
  {
    table: "LegacySalesLine",
    cols: "productId",
    refTable: "Product",
    refCols: "id",
    onDelete: "RESTRICT",
  },
  {
    table: "SourceItemAlias",
    cols: "productId",
    refTable: "Product",
    refCols: "id",
    onDelete: "RESTRICT",
  },
];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const names = (s: string) =>
  s
    .split(",")
    .map((x) => x.replace(/["\s]/g, ""))
    .join(",");

/** SQL without `--` comment lines. The migrations carry no `--` inside a string or a quoted name. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n");
}

/** Statements of one migration, with each dollar-quoted body kept in the statement it belongs to. */
function statementsOf(sql: string): string[] {
  const code = stripLineComments(sql);
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < code.length) {
    if (code[i] === "$" && code[i + 1] === "$") {
      const end = code.indexOf("$$", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      cur += code.slice(i, stop);
      i = stop;
    } else if (code[i] === ";") {
      if (norm(cur)) out.push(norm(cur));
      cur = "";
      i += 1;
    } else {
      cur += code[i];
      i += 1;
    }
  }
  if (norm(cur)) out.push(norm(cur));
  return out;
}

const q = (name: string) => `"${name}"`;
const namesGuarded = (text: string, models: readonly string[]) =>
  models.some((m) => text.includes(q(m)) || text.includes(`'${m}'`));

interface FoundFk {
  table: string;
  cols: string;
  refTable: string;
  refCols: string;
  onDelete: string;
  onUpdate: string;
}

const FK_RE =
  /FOREIGN KEY \(([^)]*)\) REFERENCES "([A-Za-z0-9_]+)"\s*\(([^)]*)\)((?: ON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT))*)/g;

/** Every foreign key a statement declares, with the table that holds it (an inline CREATE TABLE one or an ALTER TABLE one). */
function fksOf(stmt: string): FoundFk[] {
  const table =
    /^CREATE TABLE "([A-Za-z0-9_]+)"/.exec(stmt)?.[1] ??
    /^ALTER TABLE "([A-Za-z0-9_]+)"/.exec(stmt)?.[1];
  if (!table) return [];
  const out: FoundFk[] = [];
  for (const m of stmt.matchAll(FK_RE)) {
    const actions = m[4] ?? "";
    out.push({
      table,
      cols: names(m[1] ?? ""),
      refTable: m[2] ?? "",
      refCols: names(m[3] ?? ""),
      onDelete:
        /ON DELETE (CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT)/.exec(actions)?.[1] ??
        "(none)",
      onUpdate:
        /ON UPDATE (CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT)/.exec(actions)?.[1] ??
        "(none)",
    });
  }
  return out;
}

/** Every problem with the guard and FK set across the given migration files (name -> sql) and MODEL_DOMAIN keys. */
export function guardProblems(
  files: Record<string, string>,
  modelDomainKeys: readonly string[],
  guarded: readonly string[] = IMPORT_HISTORY_MODELS,
): string[] {
  const problems: string[] = [];
  const stmts = Object.entries(files).flatMap(([file, sql]) =>
    statementsOf(sql).map((stmt) => ({ file, stmt })),
  );

  // 1. exactly one guard trigger per guarded table, with the exact text.
  for (const m of guarded) {
    const want = `CREATE TRIGGER "${m}_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "${m}" FOR EACH ROW EXECUTE FUNCTION "${GUARD_FN}"()`;
    const n = stmts.filter((s) => s.stmt === want).length;
    if (n !== 1) problems.push(`${m}: expected exactly one guard trigger line, found ${n}`);
  }

  // 2. every Legacy* model of the schema is a guarded table.
  for (const key of modelDomainKeys) {
    if (/^Legacy/.test(key) && !guarded.includes(key)) {
      problems.push(`${key}: a MODEL_DOMAIN key matching ^Legacy is not in IMPORT_HISTORY_MODELS`);
    }
  }

  // 3. the FK set (A1-1): equal to the nine, nothing else names a guarded table.
  const found = stmts.flatMap((s) => fksOf(s.stmt));
  const involved = found.filter((f) => guarded.includes(f.table) || guarded.includes(f.refTable));
  const key = (f: { table: string; cols: string; refTable: string; refCols: string }) =>
    `${f.table}(${f.cols}) -> ${f.refTable}(${f.refCols})`;
  for (const w of EXPECTED_FKS) {
    const hits = involved.filter((f) => key(f) === key(w));
    if (hits.length !== 1) {
      problems.push(`FK ${key(w)}: expected exactly one, found ${hits.length}`);
      continue;
    }
    if (hits[0]!.onDelete !== w.onDelete) {
      problems.push(`FK ${key(w)}: ON DELETE ${hits[0]!.onDelete}, expected ${w.onDelete}`);
    }
    if (hits[0]!.onUpdate !== "NO ACTION") {
      problems.push(`FK ${key(w)}: ON UPDATE ${hits[0]!.onUpdate}, expected NO ACTION`);
    }
  }
  for (const f of involved) {
    if (!EXPECTED_FKS.some((w) => key(w) === key(f))) problems.push(`unexpected FK ${key(f)}`);
  }

  // 4. no function, trigger or rule names a guarded table, apart from the guard and its six triggers.
  for (const { stmt } of stmts) {
    const m = /^CREATE (?:OR REPLACE )?(FUNCTION|TRIGGER|RULE) "?([A-Za-z0-9_]+)"?/.exec(stmt);
    if (!m || !namesGuarded(stmt, guarded)) continue;
    const isGuardFn = m[1] === "FUNCTION" && m[2] === GUARD_FN;
    const isGuardTrigger =
      m[1] === "TRIGGER" &&
      guarded.some((g) => stmt.startsWith(`CREATE TRIGGER "${g}_tenant_guard" `));
    if (!isGuardFn && !isGuardTrigger) {
      problems.push(
        `${m[1]} ${m[2]} names a guarded table and is not the guard or one of its triggers`,
      );
    }
  }
  return problems;
}

/** The keys of the `MODEL_DOMAIN` object literal, read from the AST. */
export function modelDomainKeysOf(text: string): string[] {
  const sf = ts.createSourceFile(
    "split-prisma-schema.mjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "MODEL_DOMAIN" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          keys.push(p.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** The file's text with LF line ends, whatever the checkout's autocrlf made of it. */
const readSql = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function migrationFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of fs.readdirSync(MIGRATIONS_DIR)) {
    const file = path.join(MIGRATIONS_DIR, dir, "migration.sql");
    if (fs.existsSync(file)) out[dir] = readSql(file);
  }
  return out;
}

describe("SA-1507 P6: tenant guard presence and the FK set of the guarded tables (static half)", () => {
  const files = migrationFiles();
  const keys = modelDomainKeysOf(fs.readFileSync(SPLIT_SCRIPT, "utf8"));

  it("scans the stage-1 migration and finds MODEL_DOMAIN's keys (the walk is not empty)", () => {
    expect(Object.keys(files)).toContain(STAGE1);
    expect(Object.keys(files).length).toBeGreaterThan(50);
    expect(keys.length).toBeGreaterThan(150);
    expect(keys).toEqual(expect.arrayContaining([...IMPORT_HISTORY_MODELS]));
  });

  it("lists exactly the six guarded tables, frozen", () => {
    expect([...IMPORT_HISTORY_MODELS]).toEqual([
      "LegacyImportBatch",
      "LegacyImportFile",
      "LegacyImportIssue",
      "LegacySalesDocument",
      "LegacySalesLine",
      "SourceItemAlias",
    ]);
    expect(Object.isFrozen(IMPORT_HISTORY_MODELS)).toBe(true);
  });

  it("R-253 LOW-1: the sitting check script lists the same guarded tables and the same nine foreign keys (read by AST)", () => {
    const file = path.join(API_DIR, "scripts", "sitting-s1295-1-check.mjs");
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const strings = (name: string): string[] | null => {
      let found: string[] | null = null;
      sf.forEachChild((n) => {
        if (!ts.isVariableStatement(n)) return;
        for (const d of n.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
          let init: ts.Expression = d.initializer;
          while (ts.isCallExpression(init) || ts.isPropertyAccessExpression(init)) {
            init = ts.isCallExpression(init) ? init.expression : init.expression;
          }
          if (ts.isArrayLiteralExpression(init)) {
            found = init.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
          }
        }
      });
      return found;
    };
    const guarded = strings("GUARDED");
    const fks = strings("EXPECTED_FKS");
    expect(guarded).not.toBeNull();
    expect(fks).not.toBeNull();
    expect([...guarded!].sort()).toEqual([...IMPORT_HISTORY_MODELS].sort());
    const code = { CASCADE: "c", "SET NULL": "n", RESTRICT: "r" } as Record<string, string>;
    const want = EXPECTED_FKS.map(
      (f) => `${f.table}(${f.cols}) -> ${f.refTable}(${f.refCols}) del=${code[f.onDelete]} upd=a`,
    ).sort();
    expect([...fks!].sort()).toEqual(want);
  });

  it("the tree has no problem: six guard triggers, the nine A1-1 FKs, no other body naming a guarded table", () => {
    expect(guardProblems(files, keys)).toEqual([]);
  });

  describe("probes: each rule is red on the thing it forbids", () => {
    const stage1 = files[STAGE1]!;
    const probe = (
      extra: string,
      mutate: (sql: string) => string = (s) => s,
      more: string[] = [],
    ) => guardProblems({ ...files, [STAGE1]: mutate(stage1) + extra }, [...keys, ...more]);

    it("a LegacyFoo key in MODEL_DOMAIN is red until it is listed and triggered", () => {
      expect(probe("", (s) => s, ["LegacyFoo"])).toEqual([
        "LegacyFoo: a MODEL_DOMAIN key matching ^Legacy is not in IMPORT_HISTORY_MODELS",
      ]);
    });

    it("a missing trigger line is red, a doubled one too", () => {
      const line = (m: string) =>
        `CREATE TRIGGER "${m}_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "${m}" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();`;
      expect(probe("", (s) => s.replace(line("SourceItemAlias"), ""))).toEqual([
        "SourceItemAlias: expected exactly one guard trigger line, found 0",
      ]);
      expect(probe(`\n${line("LegacySalesLine")}\n`)).toEqual([
        "LegacySalesLine: expected exactly one guard trigger line, found 2",
      ]);
      // a changed event list is not the guard line
      expect(
        probe("", (s) =>
          s.replace(line("LegacySalesLine"), line("LegacySalesLine").replace("OR DELETE", "")),
        ),
      ).toEqual(["LegacySalesLine: expected exactly one guard trigger line, found 0"]);
    });

    it("a wrong action is red: SET NULL on a productId FK, ON UPDATE CASCADE", () => {
      expect(
        probe("", (s) =>
          s.replace(
            '"LegacySalesLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT',
            '"LegacySalesLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL',
          ),
        ),
      ).toEqual([
        "FK LegacySalesLine(productId) -> Product(id): ON DELETE SET NULL, expected RESTRICT",
      ]);
      expect(
        probe("", (s) =>
          s.replace(
            'REFERENCES "LegacyImportBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,\n    CONSTRAINT "LegacyImportIssue_tenantId_fileId_fkey"',
            'REFERENCES "LegacyImportBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "LegacyImportIssue_tenantId_fileId_fkey"',
          ),
        ),
      ).toEqual([
        "FK LegacyImportIssue(tenantId,batchId) -> LegacyImportBatch(tenantId,id): ON UPDATE CASCADE, expected NO ACTION",
      ]);
    });

    it("an extra FK into a guarded table is red, from a new table or from an ALTER on an old one", () => {
      expect(
        probe(
          `\nALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_x_fkey" FOREIGN KEY ("x") REFERENCES "LegacySalesDocument"("id") ON DELETE CASCADE ON UPDATE NO ACTION;\n`,
        ),
      ).toEqual(["unexpected FK Invoice(x) -> LegacySalesDocument(id)"]);
    });

    it("a second function or trigger that names a guarded table is red", () => {
      expect(
        probe(
          `\nCREATE FUNCTION "audit_x"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "LegacySalesLine"("id") VALUES ('x'); RETURN NEW; END; $$;\n`,
        ),
      ).toEqual([
        "FUNCTION audit_x names a guarded table and is not the guard or one of its triggers",
      ]);
      expect(
        probe(
          `\nCREATE TRIGGER "LegacySalesLine_audit" AFTER INSERT ON "LegacySalesLine" FOR EACH ROW EXECUTE FUNCTION "audit_x"();\n`,
        ),
      ).toEqual([
        "TRIGGER LegacySalesLine_audit names a guarded table and is not the guard or one of its triggers",
      ]);
    });
  });
});
