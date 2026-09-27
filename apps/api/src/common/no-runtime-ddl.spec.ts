/**
 * T1 (R1): static DDL tripwire.
 *
 * Nothing under `apps/api/src` may issue runtime DDL via Prisma's raw-query
 * escape hatches (`$executeRaw*` / `$queryRaw*` — Postgres runs DDL through a
 * query just as happily as through an execute) OR a raw `pg` client
 * (`<anything>.query(...)`). Schema changes must flow through Prisma
 * migrations, never a boot-time or request-time `CREATE`/`ALTER`/`DROP`. A
 * file only offends when it contains BOTH such a raw-execution call AND a DDL
 * keyword (`CREATE|ALTER|DROP TABLE|INDEX|COLUMN|TYPE|SCHEMA`) — either alone
 * is not proof of runtime DDL.
 *
 * The `pg`-client half of the pattern is load-bearing, and deliberately
 * matches ANY receiver rather than a fixed list of variable names: `main.ts`
 * formerly issued its `ALTER TABLE` DDL through `new Pool(...).query(...)`
 * (deleted in PR-1, imp-03a), never `$executeRaw*`, so a Prisma-only — or a
 * `pool`/`client`/`db`-only — pattern would let that exact shape return under
 * one renamed variable.
 *
 * Before implementation this must list the two known boot-time DDL sites
 * (`main.ts`, `platform-admin/platform-config.service.ts`); after PR-1
 * removes them, the list must be empty.
 *
 * The walk covers `apps/api/scripts/**` as well as `apps/api/src/**`: the
 * legacy one-off DDL writers lived there, so leaving them unwatched would keep
 * a second, un-migrated schema path alive. Exempt by design:
 *   - `apply-rls.js` — applies row-level-security POLICIES, which the Prisma
 *     datamodel cannot express and `migrate diff` never sees; it is a manual,
 *     documented step in `apps/api/docs/production-setup.md`.
 *   - the owner-run T6 ops scripts (see `SCRIPT_EXCLUSIONS`, one reason each).
 *   - any file under a `testing/` directory of `src` (see `TESTING_SEGMENT`).
 * (`schema-drift.mjs`, `prod-migrate.mjs`, and `lib/railway-db-url.mjs` were
 * once listed here too, but none of them ever contains a DDL keyword — the
 * exclusion was dead, so it was removed rather than carried forward.)
 * Comments are stripped before matching, so a documented example of the shape
 * (like this block) cannot turn the tripwire red.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join, relative, sep } from "path";

const SRC_ROOT = join(__dirname, "..");
const SCRIPTS_ROOT = join(__dirname, "..", "..", "scripts");

// Every entry needs its own `reason:` line, and the last test in this file fails if an entry stops
// resolving to a file on disk (a stale exemption after a rename silently guards nothing).
const SCRIPT_EXCLUSIONS = new Set([
  // reason: applies row-level-security POLICIES, which the Prisma datamodel cannot express and
  // `migrate diff` never sees; a manual, documented step (apps/api/docs/production-setup.md).
  "apply-rls.js",
  // reason: T6 owner-run rollback — drops the 56 `<table>_tenantId_nn` CHECK constraints in one
  // transaction, and only with --yes-drop-t6-guards. Hand-run via `railway run`; apps/api/scripts/**
  // is outside tsconfig.build.json, so it never enters the API image.
  "t6-drop-guards.mjs",
  // reason: T6 owner-run READ-ONLY census; it contains DDL text only inside a regex that PARSES the
  // T6 migration (to list the guarded tables) and runs SELECT count(*) in a READ ONLY transaction.
  // Hand-run via `railway run`; never enters the API image (outside tsconfig.build.json).
  "t6-null-census.mjs",
  // reason: T6 owner-run READ-ONLY forensic report; like the census it holds DDL text only inside a
  // regex that PARSES the T6 migration (to list the guarded tables) and runs SELECTs in a READ ONLY
  // transaction. Hand-run via `railway run`; never enters the API image. (The sibling stamp script
  // t6-stamp-null-rows.mjs contains no DDL keyword, so it needs no exemption and gets none.)
  "t6-null-rows-report.mjs",
  // reason: #2118/SA-314 LOCAL-only benchmark (refuses any non-local DATABASE_URL via
  // requireLocalDatabaseUrl). `--index-build` times a DROP + CREATE of the four indexes migration
  // 20260925160000 already created, in ONE transaction (a failure rolls back to the original), so
  // the schema ends exactly as migrated — it measures the build, it is never a schema path. Outside
  // tsconfig.build.json; never enters the API image.
  "sales-facts-timing.ts",
]);

/**
 * Directory class exempt from the `src` walk: any path with a `testing/` segment. Same shape as
 * `TESTING_SEGMENT` in `no-test-code-in-prod.spec.ts`, which enforces on the IMPORT EDGE (static,
 * re-export, dynamic `import()` and `require`) that no non-spec file outside a `testing/` directory
 * imports one. That is strictly stronger than a name list: it proves this DDL (e.g. the T6
 * `relaxTenantIdGuards` test helper) is unreachable from the running API, which is what T1 exists to
 * guarantee.
 */
const TESTING_SEGMENT = /(^|\/)testing(\/|$)/;

const EXEC_RAW_PATTERN = /(\$(execute|query)Raw(Unsafe)?\s*[(`]|\b[A-Za-z_$][\w$]*\.query\s*[(`])/i;
const DDL_PATTERN =
  /\b(CREATE|ALTER|DROP)\s+(?:(?:UNIQUE|OR\s+REPLACE|MATERIALIZED)\s+)?(TABLE|INDEX|COLUMN|TYPE|SCHEMA|VIEW|SEQUENCE|FUNCTION|TRIGGER|EXTENSION)\b/i;

/**
 * Remove `//` line and block comments while leaving string/template contents
 * untouched, so prose ABOUT runtime DDL never counts as runtime DDL.
 *
 * Known limitation: regex literals are not tracked, so a regex containing an
 * unescaped `//` or `/*` can swallow the rest of a line/file. That is
 * conservative in the safe direction for a tripwire only when it hides an
 * offender in the SAME file — no current file uses that shape, and a hidden
 * offender would still be caught by review of the raw-DDL call itself.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        const q = src[i];
        if (q === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += q;
        i++;
        if (q === c) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const rel = (root: string, file: string) => relative(root, file).split(sep).join("/");

function collectSourceFiles(): string[] {
  return walk(SRC_ROOT).filter((file) => {
    const entry = basename(file);
    if (TESTING_SEGMENT.test(rel(SRC_ROOT, file))) return false;
    return entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".spec.ts");
  });
}

function collectScriptFiles(): string[] {
  if (!existsSync(SCRIPTS_ROOT)) return [];
  return walk(SCRIPTS_ROOT).filter((file) => {
    const relPath = rel(SCRIPTS_ROOT, file);
    if (SCRIPT_EXCLUSIONS.has(relPath)) return false;
    const entry = basename(file);
    if (entry.endsWith(".d.ts") || entry.endsWith(".spec.ts")) return false;
    return /\.(js|cjs|mjs|ts)$/.test(entry);
  });
}

/** Same offender test the main tripwire uses, factored out so a fixture
 * directory (see the temp-dir test below) exercises the identical
 * walk + comment-strip + pattern-match pipeline as the real scan. */
function detectOffenders(files: string[]): string[] {
  return files.filter((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    return EXEC_RAW_PATTERN.test(source) && DDL_PATTERN.test(source);
  });
}

describe("API runtime DDL (T1)", () => {
  it("never issues raw-SQL DDL ($executeRaw* or a pg client) from a compiled source file", () => {
    const candidates = [
      ...collectSourceFiles().map((file) => ({ file, label: rel(SRC_ROOT, file) })),
      ...collectScriptFiles().map((file) => ({
        file,
        label: `scripts/${rel(SCRIPTS_ROOT, file)}`,
      })),
    ];

    const offenderFiles = new Set(detectOffenders(candidates.map(({ file }) => file)));
    const offenders = candidates
      .filter(({ file }) => offenderFiles.has(file))
      .map(({ label }) => label)
      .sort();

    expect(offenders).toEqual([]);
  });

  it("walk() + detectOffenders() flag exactly the one offending file in an arbitrary directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-runtime-ddl-"));
    try {
      const offenderFile = join(dir, "offender.ts");
      writeFileSync(offenderFile, "await pool.query('ALTER TABLE \"X\" ADD COLUMN y TEXT')");
      writeFileSync(join(dir, "clean.ts"), "const a = 1;\n");

      expect(detectOffenders(walk(dir))).toEqual([offenderFile]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every SCRIPT_EXCLUSIONS entry resolves to a file on disk (no stale exemption)", () => {
    for (const entry of SCRIPT_EXCLUSIONS) {
      expect(existsSync(join(SCRIPTS_ROOT, entry))).toBe(true);
    }
  });

  it("uses the SAME `testing/` segment regex as no-test-code-in-prod.spec.ts (the two guards cannot drift)", () => {
    const other = readFileSync(join(__dirname, "no-test-code-in-prod.spec.ts"), "utf8");
    expect(other).toContain(`const TESTING_SEGMENT = ${TESTING_SEGMENT.toString()};`);
  });

  it("does not exempt a `testing`-lookalike directory (only an exact `testing/` segment)", () => {
    expect(TESTING_SEGMENT.test("common/testing/db-spec.ts")).toBe(true);
    expect(TESTING_SEGMENT.test("testing/x.ts")).toBe(true);
    expect(TESTING_SEGMENT.test("common/testing-utils/x.ts")).toBe(false);
    expect(TESTING_SEGMENT.test("common/mytesting/x.ts")).toBe(false);
  });

  it("scans the scripts directory, not just src", () => {
    // Anti-vacuity: an empty offender list must mean "nothing offends", not
    // "nothing was read".
    expect(collectScriptFiles().length).toBeGreaterThan(0);
  });

  it("strips comments so documented DDL prose cannot fail the tripwire", () => {
    const commented = stripComments(
      "// await pool.query('ALTER TABLE \"X\" ADD COLUMN y TEXT')\nconst a = 1;\n",
    );
    expect(EXEC_RAW_PATTERN.test(commented) && DDL_PATTERN.test(commented)).toBe(false);
  });

  it("keeps string and template contents while stripping comments", () => {
    const out = stripComments('const s = "ALTER TABLE keep"; /* drop me */ const t = `CREATE`;');
    expect(out).toContain("ALTER TABLE keep");
    expect(out).toContain("CREATE");
    expect(out).not.toContain("drop me");
  });

  it.each([
    ["a renamed pg pool", "await pgPool.query('ALTER TABLE \"Order\" ADD COLUMN x TEXT')"],
    ["a member pg client", 'await this.pgClient.query(`CREATE TABLE IF NOT EXISTS "X" ()`)'],
    ["$queryRawUnsafe", 'await prisma.$queryRawUnsafe("CREATE TABLE IF NOT EXISTS \\"X\\" ()")'],
    ["$executeRaw", 'await prisma.$executeRaw`DROP INDEX IF EXISTS "X_idx"`'],
  ])("flags raw execution via %s", (_label, sample) => {
    expect(EXEC_RAW_PATTERN.test(sample)).toBe(true);
  });

  it("does not flag a non-query call such as queryBus.execute(", () => {
    expect(EXEC_RAW_PATTERN.test("await queryBus.execute(new GetOrdersQuery())")).toBe(false);
  });
});
