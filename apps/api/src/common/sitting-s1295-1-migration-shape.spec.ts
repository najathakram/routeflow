import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1295 Sitting 1 (QuickBooks history import, stage-1 schema) with the SA-1507 tenant guard: the three migration
 * folders are READ at test time and pinned by shape. The DB specs prove the behaviour; this one proves the files say what
 * the contract says, and goes red on each way the file can drift (probes at the end run the same rules on mutated text).
 *
 *   20261126000000_legacy_import_stage1: ONE BEGIN/COMMIT, lock_timeout first, then in this order: CREATE TYPE x6,
 *     CREATE TABLE x6 (FKs inline), CREATE FUNCTION legacy_import_tenant_guard, CREATE TRIGGER x6, indexes, and LAST the
 *     ImportExternalRef ALTER (two nullable columns, no default).
 *   20261126000100: the partial unique index, alone.   20261126000200: ADD VALUE IMPORTED_SUMMARY, alone.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const STAGE1 = "20261126000000_legacy_import_stage1";
const INDEX_FOLDER = "20261126000100_import_external_ref_confirmed_unique";
const ENUM_FOLDER = "20261126000200_invoice_item_system_kind_imported_summary";

export const GUARDED = [
  "LegacyImportBatch",
  "LegacyImportFile",
  "LegacyImportIssue",
  "LegacySalesDocument",
  "LegacySalesLine",
  "SourceItemAlias",
];
const ENUMS = [
  "LegacyImportBatchStatus",
  "LegacyImportFileKind",
  "LegacyImportIssueSeverity",
  "LegacySalesDocumentKind",
  "LegacySalesLineKind",
  "LegacyItemMatchMethod",
];

const read = (folder: string): string =>
  readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8").replace(/\r\n/g, "\n");

/** SQL with `--` comment lines removed (a `--` inside the function body is a comment too). */
const executable = (sql: string): string =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The text between `AS $$` and the closing `$$;` of the guard function, comments dropped and whitespace squashed. */
export function guardBody(sql: string): string | null {
  const m = /CREATE FUNCTION "legacy_import_tenant_guard"\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/.exec(
    executable(sql),
  );
  return m ? squash(m[1]) : null;
}

/**
 * The six steps in order, as the fragments each must contain. A fragment missing or out of order is a drift of the
 * contract (SA-1507 R1 steps 1-6 with Amendment 1 A1-2 step 2).
 */
export const BODY_FRAGMENTS = [
  "s := NULLIF(current_setting('app.current_tenant_id', true), '');",
  "IF pg_trigger_depth() > 1 THEN IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'LegacySalesDocument' THEN",
  'IF NEW."tenantId"::text = OLD."tenantId"::text AND OLD."customerId" IS NOT NULL AND NEW."customerId" IS NULL AND (to_jsonb(NEW) - \'customerId\') = (to_jsonb(OLD) - \'customerId\') THEN RETURN NEW;',
  "IF s IS NULL THEN RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501'; END IF;",
  "IF TG_OP = 'INSERT' THEN IF NEW.\"tenantId\"::text <> s THEN",
  'ELSIF TG_OP = \'UPDATE\' THEN IF OLD."tenantId"::text <> s OR NEW."tenantId"::text <> OLD."tenantId"::text THEN',
  'ELSE IF OLD."tenantId"::text <> s THEN',
  "v := to_jsonb(NEW) ->> 'customerId';",
  'FROM "Customer" c WHERE c."id" = v AND c."tenantId" = NEW."tenantId"::text',
  "v := to_jsonb(NEW) ->> 'productId';",
  'FROM "Product" p WHERE p."id" = v AND p."tenantId" = NEW."tenantId"::text',
  "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END;",
];

/** Every rule on the stage-1 file; returns the problems found (empty = the file matches the contract). */
export function stage1Problems(raw: string): string[] {
  const problems: string[] = [];
  const sql = executable(raw);
  const statements = (sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$") + "\n")
    .split(";")
    .map(squash)
    .filter(Boolean);

  if ((sql.match(/^BEGIN;/gm) ?? []).length !== 1) problems.push("not exactly one BEGIN;");
  if ((sql.match(/^COMMIT;/gm) ?? []).length !== 1) problems.push("not exactly one COMMIT;");
  if (statements[0] !== "BEGIN") problems.push("first statement is not BEGIN");
  if (statements[1] !== "SET LOCAL lock_timeout = '5s'")
    problems.push("lock_timeout is not the second statement");
  if (statements[statements.length - 1] !== "COMMIT") problems.push("last statement is not COMMIT");
  if (/squawk-ignore/.test(raw)) problems.push("a squawk-ignore is present");

  // order of the sections
  const at = (re: RegExp): number => {
    const m = re.exec(sql);
    return m ? m.index : -1;
  };
  const lastAt = (re: RegExp): number => {
    let idx = -1;
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(sql))) idx = m.index;
    return idx;
  };
  const firstType = at(/CREATE TYPE /);
  const lastType = lastAt(/CREATE TYPE /);
  const firstTable = at(/CREATE TABLE /);
  const lastTable = lastAt(/CREATE TABLE /);
  const fn = at(/CREATE FUNCTION "legacy_import_tenant_guard"/);
  const firstTrigger = at(/CREATE TRIGGER /);
  const lastTrigger = lastAt(/CREATE TRIGGER /);
  const firstIndex = at(/CREATE (UNIQUE )?INDEX /);
  const lastIndex = lastAt(/CREATE (UNIQUE )?INDEX /);
  const alter = at(/ALTER TABLE "ImportExternalRef"/);
  const ordered = [
    firstType,
    lastType,
    firstTable,
    lastTable,
    fn,
    firstTrigger,
    lastTrigger,
    firstIndex,
    lastIndex,
    alter,
  ];
  if (ordered.some((n) => n < 0) || ordered.some((n, i) => i > 0 && n < ordered[i - 1])) {
    problems.push(
      "sections are not in the order types, tables, function, triggers, indexes, ImportExternalRef ALTER",
    );
  }
  if ((sql.match(/CREATE TYPE /g) ?? []).length !== 6) problems.push("not six CREATE TYPE");
  if ((sql.match(/CREATE TABLE /g) ?? []).length !== 6) problems.push("not six CREATE TABLE");
  // three ALTER TABLE: the not-NaN checks on the two new tables, then the ImportExternalRef one, last
  if ((sql.match(/ALTER TABLE /g) ?? []).length !== 3)
    problems.push(
      "not exactly three ALTER TABLE (two not-NaN check lists, then the ImportExternalRef one, last)",
    );
  if (lastAt(/ALTER TABLE /) !== alter)
    problems.push("the ImportExternalRef ALTER is not the last ALTER TABLE");
  if (
    (
      sql.match(
        /ADD CONSTRAINT "[A-Za-z]+_[A-Za-z]+_not_nan" CHECK \("[A-Za-z]+" <> 'NaN'::numeric\)/g,
      ) ?? []
    ).length !== 10
  )
    problems.push("not ten not-NaN checks (7 on LegacySalesDocument, 3 on LegacySalesLine)");
  for (const t of ENUMS)
    if (!sql.includes(`CREATE TYPE "${t}" AS ENUM`)) problems.push(`enum ${t} not created`);

  // the ImportExternalRef ALTER: two nullable columns, no default, nothing else
  const alterStmt = statements.find((s) => s.startsWith('ALTER TABLE "ImportExternalRef"')) ?? "";
  if (
    squash(alterStmt) !==
    'ALTER TABLE "ImportExternalRef" ADD COLUMN "confirmedAt" TIMESTAMP(3), ADD COLUMN "confirmedById" TEXT'
  ) {
    problems.push("the ImportExternalRef ALTER is not the two nullable columns with no default");
  }

  // tenantId NOT NULL on all six; inline (tenantId, id) unique on the three guarded parents
  for (const t of GUARDED) {
    const m = new RegExp(`CREATE TABLE "${t}" \\(([\\s\\S]*?)\\n\\);`).exec(sql);
    if (!m) {
      problems.push(`table ${t} not found`);
      continue;
    }
    if (!/"tenantId" TEXT NOT NULL/.test(m[1])) problems.push(`${t}.tenantId is not TEXT NOT NULL`);
  }
  for (const t of ["LegacyImportBatch", "LegacyImportFile", "LegacySalesDocument"]) {
    if (!new RegExp(`CONSTRAINT "${t}_tenantId_id_key" UNIQUE \\("tenantId", "id"\\)`).test(sql)) {
      problems.push(`${t} has no inline (tenantId, id) unique`);
    }
  }
  // no FK clause without an explicit action pair, no ON UPDATE other than NO ACTION
  const fkClauses = sql.match(/REFERENCES "[A-Za-z]+"\([^)]*\)[^,\n]*/g) ?? [];
  if (fkClauses.length !== 9)
    problems.push(`foreign keys: expected 9 inline, found ${fkClauses.length}`);
  for (const c of fkClauses) {
    if (!/ON DELETE (CASCADE|SET NULL|RESTRICT) ON UPDATE NO ACTION$/.test(c.trim())) {
      problems.push(`a foreign key has no explicit ON DELETE ... ON UPDATE NO ACTION: ${c.trim()}`);
    }
  }

  // the six trigger lines, exact
  const triggerLines = sql.split("\n").filter((l) => l.startsWith("CREATE TRIGGER "));
  const wantLines = GUARDED.map(
    (t) =>
      `CREATE TRIGGER "${t}_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();`,
  );
  if (JSON.stringify(triggerLines) !== JSON.stringify(wantLines))
    problems.push("the six CREATE TRIGGER lines differ");

  // the function: header, body fragments in order, nothing that widens it
  const header =
    /CREATE FUNCTION "legacy_import_tenant_guard"\(\) RETURNS trigger\s+LANGUAGE plpgsql AS \$\$/.test(
      sql,
    );
  if (!header)
    problems.push(
      "function header is not RETURNS trigger LANGUAGE plpgsql with no SECURITY clause",
    );
  const body = guardBody(raw);
  if (body === null) problems.push("function body not found");
  else {
    let pos = 0;
    for (const f of BODY_FRAGMENTS) {
      const i = body.indexOf(f, pos);
      if (i < 0) {
        problems.push(`body fragment missing or out of order: ${f.slice(0, 60)}`);
        break;
      }
      pos = i + f.length;
    }
    if (
      (
        body.match(
          /RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501'/g,
        ) ?? []
      ).length !== 6
    ) {
      problems.push(
        "not six refusals of the form RAISE EXCEPTION '...: %', TG_TABLE_NAME USING ERRCODE = '42501'",
      );
    }
    if ((body.match(/RAISE /g) ?? []).length !== 6)
      problems.push("a RAISE other than the six refusals");
    if (
      /SECURITY DEFINER|session_replication_role|set_config|EXECUTE |tenantId" IS NULL/i.test(body)
    ) {
      problems.push("the body has a widening construct");
    }
  }
  if (/SECURITY DEFINER/i.test(sql)) problems.push("SECURITY DEFINER appears");

  // N1: the three FK-leading indexes the composite FKs need on the child side
  for (const idx of [
    'CREATE INDEX "LegacySalesDocument_tenantId_fileId_idx" ON "LegacySalesDocument"("tenantId", "fileId")',
    'CREATE INDEX "LegacySalesDocument_customerId_idx" ON "LegacySalesDocument"("customerId")',
    'CREATE INDEX "LegacySalesLine_productId_idx" ON "LegacySalesLine"("productId")',
  ]) {
    if (!sql.includes(idx)) problems.push(`N1 index missing: ${idx}`);
  }
  if (
    !sql.includes('CREATE INDEX "SourceItemAlias_productId_idx" ON "SourceItemAlias"("productId")')
  ) {
    problems.push("SourceItemAlias productId index missing");
  }
  // Postgres cuts an identifier at 63 bytes; Prisma names a longer index differently, which db:drift reports as a rename.
  for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)) {
    if (Buffer.byteLength(m[1]) > 63) problems.push(`index name over 63 bytes: ${m[1]}`);
  }
  return problems;
}

describe("stage-1 migration shape (SA-1295 sitting 1, SA-1507)", () => {
  const folders = readdirSync(MIGRATIONS_DIR);
  const stage1 = read(STAGE1);

  it("the three folders are on disk, in order, after the previous newest", () => {
    for (const f of [STAGE1, INDEX_FOLDER, ENUM_FOLDER]) expect(folders).toContain(f);
    expect(STAGE1 < INDEX_FOLDER && INDEX_FOLDER < ENUM_FOLDER).toBe(true);
  });

  it("the stage-1 file matches the contract on every rule", () => {
    expect(stage1Problems(stage1)).toEqual([]);
  });

  it("SA-1522 Q1: LegacySalesLine has no customerId column and no index naming it (a line reaches its customer through its document)", () => {
    const sql = executable(stage1);
    const table = /CREATE TABLE "LegacySalesLine" \(([\s\S]*?)\n\);/.exec(sql);
    expect(table).not.toBeNull();
    expect(table![1]).not.toContain('"customerId"');
    const lineIndexes = [
      ...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "LegacySalesLine"[^;]*;/g),
    ];
    expect(lineIndexes.length).toBeGreaterThan(0);
    for (const m of lineIndexes) expect(m[0]).not.toContain("customerId");
    const prisma = readFileSync(
      join(__dirname, "..", "..", "prisma", "schema", "finance.prisma"),
      "utf8",
    );
    const model = /model LegacySalesLine \{([\s\S]*?)\n\}/.exec(prisma);
    expect(model).not.toBeNull();
    expect(model![1]).not.toContain("customerId");
    // SA-1529: exactly ONE direct NEW."customerId" in the guard, in its own nested IF after the Document-table test (step 2)
    const body = guardBody(stage1)!;
    expect((body.match(/NEW."customerId"/g) ?? []).length).toBe(1);
    const docTest = body.indexOf("TG_TABLE_NAME = 'LegacySalesDocument' THEN");
    expect(docTest).toBeGreaterThan(0);
    expect(body.indexOf('NEW."customerId"')).toBeGreaterThan(docTest);
    expect(body).not.toMatch(/TG_TABLE_NAME = 'LegacySalesDocument' AND/);
    expect(body).toContain("to_jsonb(NEW) ->> 'customerId'");
  });

  it("SA-1522 Q1: the covering index (tenantId, documentId, productId) is in the migration and the Prisma model", () => {
    expect(executable(stage1)).toContain(
      'CREATE INDEX "LegacySalesLine_tenantId_documentId_productId_idx" ON "LegacySalesLine"("tenantId", "documentId", "productId");',
    );
    const prisma = readFileSync(
      join(__dirname, "..", "..", "prisma", "schema", "finance.prisma"),
      "utf8",
    );
    const model = /model LegacySalesLine \{([\s\S]*?)\n\}/.exec(prisma);
    expect(model![1]).toContain("@@index([tenantId, documentId, productId])");
  });

  it("the guard function body is found and has the six steps", () => {
    const body = guardBody(stage1);
    expect(body).not.toBeNull();
    expect(body!.length).toBeGreaterThan(1500);
  });

  it("the partial unique index folder is the one statement, wrapped, on confirmedAt IS NOT NULL", () => {
    const sql = executable(read(INDEX_FOLDER));
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(squash(sql)).toContain(
      'CREATE UNIQUE INDEX "ImportExternalRef_confirmed_entity_key" ON "ImportExternalRef" ("tenantId", "externalSource", "entityType", "entityId") WHERE "confirmedAt" IS NOT NULL;',
    );
    expect((sql.match(/CREATE /g) ?? []).length).toBe(1);
    expect(read(INDEX_FOLDER)).not.toMatch(/squawk-ignore/);
  });

  it("the enum folder is ADD VALUE IMPORTED_SUMMARY alone, wrapped, and uses the value nowhere", () => {
    const sql = executable(read(ENUM_FOLDER));
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(squash(sql)).toContain(
      `ALTER TYPE "InvoiceItemSystemKind" ADD VALUE 'IMPORTED_SUMMARY';`,
    );
    expect((sql.match(/IMPORTED_SUMMARY/g) ?? []).length).toBe(1);
    expect((sql.match(/ALTER TYPE/g) ?? []).length).toBe(1);
    expect(read(ENUM_FOLDER)).not.toMatch(/squawk-ignore/);
  });

  describe("probes: each drift of the stage-1 file is caught", () => {
    const cases: Array<[string, (s: string) => string, RegExp]> = [
      ["a second BEGIN", (s) => s.replace("COMMIT;", "COMMIT;\nBEGIN;"), /BEGIN/],
      [
        "lock_timeout dropped",
        (s) => s.replace("SET LOCAL lock_timeout = '5s';", ""),
        /lock_timeout/,
      ],
      [
        "a trigger event dropped",
        (s) =>
          s.replace(
            '"LegacySalesLine_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE',
            '"LegacySalesLine_tenant_guard" BEFORE INSERT OR UPDATE',
          ),
        /CREATE TRIGGER lines/,
      ],
      [
        "a trigger line missing",
        (s) => s.replace(/CREATE TRIGGER "SourceItemAlias_tenant_guard"[^\n]*\n/, ""),
        /CREATE TRIGGER lines/,
      ],
      [
        "the exemption widened to INSERT",
        (s) =>
          s.replace(
            "IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'LegacySalesDocument' THEN",
            "IF TG_TABLE_NAME = 'LegacySalesDocument' THEN",
          ),
        /body fragment/,
      ],
      [
        "depth test dropped",
        (s) => s.replace("IF pg_trigger_depth() > 1 THEN", "IF TRUE THEN"),
        /body fragment/,
      ],
      [
        "a DELETE depth exemption added back (Amendment 2 A2-3)",
        (s) =>
          s.replace(
            "IF pg_trigger_depth() > 1 THEN\n    IF TG_OP = 'UPDATE' AND",
            "IF pg_trigger_depth() > 1 THEN\n    IF TG_OP = 'DELETE' THEN\n      RETURN OLD;\n    END IF;\n    IF TG_OP = 'UPDATE' AND",
          ),
        /body fragment/,
      ],
      [
        "errcode changed",
        (s) => s.replace(/ERRCODE = '42501'/g, "ERRCODE = 'P0001'"),
        /refusals|fragment/,
      ],
      [
        "SECURITY DEFINER added",
        (s) => s.replace("LANGUAGE plpgsql AS $$", "LANGUAGE plpgsql SECURITY DEFINER AS $$"),
        /SECURITY/,
      ],
      [
        "a foreign key with the default action",
        (s) =>
          s.replace(
            'REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION\n);\n\n-- The tenant guard',
            'REFERENCES "Product"("id")\n);\n\n-- The tenant guard',
          ),
        /foreign key/,
      ],
      [
        "ON UPDATE CASCADE",
        (s) =>
          s.replace(
            /ON DELETE RESTRICT ON UPDATE NO ACTION/,
            "ON DELETE RESTRICT ON UPDATE CASCADE",
          ),
        /ON DELETE/,
      ],
      [
        "ALTER moved before the triggers",
        (s) => {
          const m = /ALTER TABLE "ImportExternalRef"[\s\S]*?;\n/.exec(s)!;
          return s.replace(m[0], "").replace("-- The tenant guard", m[0] + "-- The tenant guard");
        },
        /order/,
      ],
      [
        "ALTER column gets a default",
        (s) => s.replace('"confirmedById" TEXT', "\"confirmedById\" TEXT DEFAULT 'x'"),
        /ImportExternalRef ALTER/,
      ],
      ["a squawk-ignore added", (s) => s + "\n-- squawk-ignore ban-drop-column\n", /squawk/],
      [
        "an N1 index dropped",
        (s) => s.replace(/CREATE INDEX "LegacySalesLine_productId_idx"[^\n]*\n/, ""),
        /N1/,
      ],
    ];
    it("the unmutated file has no problems (control)", () => {
      expect(stage1Problems(stage1)).toEqual([]);
    });
    it.each(cases)("%s", (_name, mutate, expected) => {
      const mutated = mutate(stage1);
      expect(mutated).not.toBe(stage1);
      const problems = stage1Problems(mutated).join(" | ");
      expect(problems).toMatch(expected);
    });
  });
});
