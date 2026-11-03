import { readFileSync } from "fs";
import * as path from "path";

/**
 * SA-1088 (QD-3): the source scan. The corrected-units sheet reads a live tenant, so the three files that make it
 * up (the script, its lib, the ported read half of the query lib) must hold no write verb: no SQL that changes
 * anything, no Prisma write call, no `forTenant` write, no raw execute, no COMMIT. Comments are stripped first, so
 * a sentence saying "never UPDATE" cannot trip it, and the transaction wrapper must still be READ ONLY + ROLLBACK.
 */
const SCRIPTS = path.resolve(__dirname, "../../scripts");
const FILES = [
  "report-corrected-units-sheet.mjs",
  "lib/report-corrected-units-sheet.mjs",
  "lib/b681-ledger-query.mjs",
];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");

const WRITE_VERBS: Array<[string, RegExp]> = [
  ["SQL INSERT", /\bINSERT\b/i],
  ["SQL UPDATE", /\bUPDATE\b/i],
  ["SQL DELETE", /\bDELETE\b/i],
  ["SQL TRUNCATE / DROP / ALTER / GRANT / REVOKE", /\b(TRUNCATE|DROP|ALTER|GRANT|REVOKE)\b/i],
  ["SQL CREATE", /\bCREATE\s+(TABLE|INDEX|TEMP|TEMPORARY|VIEW|FUNCTION|SCHEMA|EXTENSION)\b/i],
  ["SQL COMMIT", /\bCOMMIT\b/i],
  ["SQL COPY / MERGE / LOCK TABLE", /\b(COPY\s+[\w"(]|MERGE\s+INTO|LOCK\s+TABLE)/i],
  ["SQL FOR UPDATE / FOR SHARE (row locks)", /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b/i],
  ["Prisma write call", /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/],
  ["forTenant", /\bforTenant\b/],
  ["raw execute", /\$executeRaw|\$queryRawUnsafe|\bexecuteRaw/],
];

describe("report-corrected-units-sheet source scan (QD-3)", () => {
  it.each(FILES)("%s holds no write verb", (file) => {
    const src = stripComments(readFileSync(path.join(SCRIPTS, file), "utf8"));
    const hits = WRITE_VERBS.filter(([, re]) => re.test(src)).map(([name]) => name);
    expect(hits).toEqual([]);
  });

  it("the scan has teeth: it flags a write verb in a sample", () => {
    const sample = stripComments(
      '// never UPDATE\nawait client.query(`UPDATE "Tenant" SET name = $1`);',
    );
    expect(WRITE_VERBS.some(([, re]) => re.test(sample))).toBe(true);
    expect(WRITE_VERBS.some(([, re]) => re.test(stripComments("// never UPDATE anything")))).toBe(
      false,
    );
    // COPY / MERGE / LOCK are write-shaped too (the READ ONLY transaction is what truly stops them)
    for (const sql of ['COPY "Tenant" FROM STDIN', "MERGE INTO t USING s", 'LOCK TABLE "Tenant"']) {
      expect(WRITE_VERBS.some(([, re]) => re.test(sql))).toBe(true);
    }
  });

  it("every read goes through the READ ONLY wrapper that ends in ROLLBACK", () => {
    const lib = readFileSync(path.join(SCRIPTS, "lib/report-corrected-units-sheet.mjs"), "utf8");
    expect(lib).toContain("SET default_transaction_read_only = on");
    expect(lib).toContain("BEGIN TRANSACTION READ ONLY");
    expect(lib).toContain('END_TX = "ROLLBACK"');
    const script = readFileSync(path.join(SCRIPTS, "report-corrected-units-sheet.mjs"), "utf8");
    expect(script).toContain("withReadOnlyTx(client");
    expect(script.match(/client\.query\(/g)).toHaveLength(1);
  });

  it("the only thing the script writes is the local CSV, under local-assets/handoff", () => {
    const script = stripComments(
      readFileSync(path.join(SCRIPTS, "report-corrected-units-sheet.mjs"), "utf8"),
    );
    expect(script.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(script).toContain('"local-assets", "handoff"');
  });
});
