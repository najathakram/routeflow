import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {
  isUnscopedBulkArg,
  scanUnscopedWrites,
  stripComments,
} from "./testing/unscoped-write-scan";

/**
 * #2421: `scripts/import-zoho.js` ran `invoice.deleteMany({})` (and ~30 more unscoped deletes)
 * against whatever DATABASE_URL was set, behind nothing but `--execute`: one run would have wiped
 * every tenant's invoices, payments, orders and customers. It is retired.
 *
 * Pin: no file under apps/api/scripts performs an UNSCOPED bulk write, i.e. `deleteMany()` /
 * `deleteMany({})` / `updateMany({})` with no where, a raw `DELETE FROM` with no WHERE, or a
 * `TRUNCATE`, unless it is on the reviewed allow-list below with a reason. A LOCAL-ONLY entry must
 * also still run the shared production guard on the URL it dials (`productionGuard({ ... dbUrl })`,
 * which refuses any non-local target before the first query, #2206/#2419). Anything that may run
 * against production scopes every bulk write by tenant or row instead.
 */
const SCRIPTS = path.resolve(__dirname, "../../scripts");

type Reviewed = { reason: string; localOnly: boolean };
const ALLOWED: Record<string, Reviewed> = {
  "DANGER-fresh-data-WIPES-ALL-DATA.js": { reason: "local dev reset (TRUNCATE)", localOnly: true },
  "cleanup-qa-data.js": { reason: "local QA cleanup; --all TRUNCATEs", localOnly: true },
  "nuke-db.js": { reason: "local dev wipe", localOnly: true },
  "nuke-tenant-data.js": { reason: "local dev wipe of all tenant data", localOnly: true },
  "reset-and-seed.ts": { reason: "local dev reset + demo seed", localOnly: true },
  "reset-seed.js": { reason: "local dev reset + seed", localOnly: true },
  "report-2179-insights-scale.mjs": {
    reason: "the DELETE is a string fed to its own assertReadOnlySql refusal check, never executed",
    localOnly: false,
  },
  "report-b949-source-deleted-applications.mjs": {
    reason:
      "the DELETE/UPDATE strings are deliberately bad examples fed to its own assertReadOnlySql refusal check, never executed",
    localOnly: false,
  },
  "report-b965-mixed-unit-returns.mjs": {
    reason:
      "the DELETE/UPDATE strings are deliberately bad examples fed to its own assertReadOnlySql refusal check, never executed",
    localOnly: false,
  },
  "report-sa773-over-credited-pools.mjs": {
    reason:
      "the DELETE/UPDATE strings are deliberately bad examples fed to its own assertReadOnlySql refusal check, never executed",
    localOnly: false,
  },
  "report-b673-next-delivery-overcharge.mjs": {
    reason:
      "the DELETEs are strings fed to its own assertReadOnlySql refusal checks, never executed",
    localOnly: false,
  },
};

const LOCAL_ONLY_GUARD = /productionGuard\(\s*\{[^}]*\bdbUrl\b/s;

function scriptFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") scriptFiles(full, out);
    } else if (/\.(c|m)?(j|t)s$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function unscopedWrites(src: string): number {
  const r = scanUnscopedWrites(src);
  return r.jsCalls.length + r.rawSql.length;
}

const scanned = scriptFiles(SCRIPTS).map((f) => {
  const rel = path.relative(SCRIPTS, f).replace(/\\/g, "/");
  const raw = fs.readFileSync(f, "utf8");
  return { rel, src: stripComments(raw), unscoped: unscopedWrites(raw) };
});

describe("#2421 apps/api/scripts: unscoped bulk writes only on the reviewed allow-list", () => {
  it("the scan covers the scripts folder, and finds the known local-only tools", () => {
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.find((s) => s.rel === "nuke-tenant-data.js")?.unscoped).toBeGreaterThan(0);
  });

  it("no file outside the allow-list performs an unscoped deleteMany/updateMany/DELETE/TRUNCATE", () => {
    const offenders = scanned
      .filter((s) => s.unscoped > 0 && !(s.rel in ALLOWED))
      .map((s) => `${s.rel} (${s.unscoped} unscoped)`);
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(ALLOWED).filter(([, r]) => r.localOnly))(
    "local-only %s still runs the production guard on the URL it dials",
    (rel) => {
      const entry = scanned.find((s) => s.rel === rel);
      expect(entry).toBeDefined();
      expect(LOCAL_ONLY_GUARD.test(entry!.src)).toBe(true);
    },
  );

  it("every allow-list entry still exists and still needs its entry (the list may only shrink)", () => {
    const stale = Object.keys(ALLOWED).filter(
      (rel) => !scanned.some((s) => s.rel === rel && s.unscoped > 0),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * #2500 (SA-481 (5)): the same pin over the ROOT scripts/ folder (repo tooling, campaign and CI
 * helpers). Every entry states why its hit is not a bulk write; the list may only shrink.
 */
const ROOT_SCRIPTS = path.resolve(__dirname, "../../../../scripts");

const ROOT_ALLOWED: Record<string, string> = {
  "ci-freshness-guard.mjs":
    "a `truncate(...)` string helper called inside template literals (log text), not SQL",
  "work/plane-release-sync.self-test.mjs":
    'self-test labels ("release update sets target_date") read as UPDATE ... SET; no SQL, no DB',
};

const rootScanned = scriptFiles(ROOT_SCRIPTS).map((f) => {
  const rel = path.relative(ROOT_SCRIPTS, f).replace(/\\/g, "/");
  return { rel, unscoped: unscopedWrites(fs.readFileSync(f, "utf8")) };
});

describe("#2500 root scripts/: unscoped bulk writes only on the reviewed allow-list", () => {
  it("the scan covers the root scripts folder, including its subfolders", () => {
    expect(rootScanned.length).toBeGreaterThan(50);
    expect(rootScanned.some((s) => s.rel.startsWith("lib/"))).toBe(true);
    expect(rootScanned.some((s) => s.rel.startsWith("work/"))).toBe(true);
  });

  it("no file outside the allow-list performs an unscoped deleteMany/updateMany/DELETE/TRUNCATE", () => {
    const offenders = rootScanned
      .filter((s) => s.unscoped > 0 && !(s.rel in ROOT_ALLOWED))
      .map((s) => `${s.rel} (${s.unscoped} unscoped)`);
    expect(offenders).toEqual([]);
  });

  it("every entry carries a reason, still exists and still needs its entry (the list may only shrink)", () => {
    for (const reason of Object.values(ROOT_ALLOWED))
      expect(reason.trim().length).toBeGreaterThan(20);
    const stale = Object.keys(ROOT_ALLOWED).filter(
      (rel) => !rootScanned.some((s) => s.rel === rel && s.unscoped > 0),
    );
    expect(stale).toEqual([]);
  });
});

describe("#2421 import-zoho.js stays retired", () => {
  const src = fs.readFileSync(path.join(SCRIPTS, "import-zoho.js"), "utf8");

  it("loads no database driver and has no bulk write", () => {
    expect(src).not.toMatch(/require\([^)]*(@prisma|["'\/]pg["'])/);
    expect(unscopedWrites(src)).toBe(0);
  });

  it("refuses unconditionally, even with --execute", () => {
    const res = spawnSync(process.execPath, [path.join(SCRIPTS, "import-zoho.js"), "--execute"], {
      encoding: "utf8",
      // Port 1 on loopback: nothing listens, so even a reinstated importer could never reach a database.
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x" },
    });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/RETIRED/);
  });
});

describe("#2421 the scanner itself (Opus review)", () => {
  it.each([
    ["no argument", ""],
    ["an empty object", "{}"],
    ["updateMany with data but no where", "{ data: { archived: true } }"],
    ["deleteMany with an empty where", "{ where: {} }"],
    ["an empty where among other keys", "{ data: { x: 1 }, where: { } }"],
  ])("flags %s", (_label, arg) => {
    expect(isUnscopedBulkArg(arg)).toBe(true);
  });

  it.each([
    ["a tenant where", "{ where: { tenantId } }"],
    ["a row where with data", "{ where: { id }, data: { x: 1 } }"],
    ["a quoted where key", '{ "where": { id: 1 } }'],
    ["a variable (not judged statically)", "args"],
    ["a spread that may carry the where", "{ ...scope, data }"],
  ])("accepts %s", (_label, arg) => {
    expect(isUnscopedBulkArg(arg)).toBe(false);
  });

  it("finds a call with whitespace before the paren", () => {
    expect(scanUnscopedWrites("await prisma.invoice.deleteMany ({});").jsCalls).toHaveLength(1);
    expect(scanUnscopedWrites("await prisma.invoice.deleteMany\n  ();").jsCalls).toHaveLength(1);
  });

  it("flags any literal containing TRUNCATE, and raw DELETE / UPDATE ... SET without WHERE", () => {
    expect(scanUnscopedWrites('const q = "truncate customers";').rawSql).toHaveLength(1);
    expect(scanUnscopedWrites('db.query(`DELETE FROM "Invoice"`);').rawSql).toHaveLength(1);
    expect(scanUnscopedWrites('db.query(`UPDATE "Order" SET total = 0`);').rawSql).toHaveLength(1);
    expect(
      scanUnscopedWrites('db.query(`UPDATE "Order" SET total = 0 WHERE id = $1`);').rawSql,
    ).toHaveLength(0);
  });

  it("joins literals concatenated with + (a WHERE in the next piece counts)", () => {
    const src = 'q(`UPDATE "User" SET s = $1` + ` WHERE "id" = $2`);';
    expect(scanUnscopedWrites(src).rawSql).toHaveLength(0);
  });

  it("strips comments only outside strings, so 'a//b' never hides the code after it", () => {
    const src = "const a = 'a//b'; x.deleteMany({}); // trailing\n/* block */ y.deleteMany({});";
    expect(stripComments(src)).toContain("x.deleteMany({})");
    expect(scanUnscopedWrites(src).jsCalls).toHaveLength(2);
    expect(scanUnscopedWrites("// x.deleteMany({})\n/* y.deleteMany({}) */").jsCalls).toHaveLength(
      0,
    );
  });

  it("text inside a string that merely mentions deleteMany({}) is not a call", () => {
    expect(
      scanUnscopedWrites('console.log("run x.deleteMany({}) with care");').jsCalls,
    ).toHaveLength(0);
  });
});
