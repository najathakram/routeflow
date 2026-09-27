import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

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
  "report-b673-next-delivery-overcharge.mjs": {
    reason:
      "the DELETEs are strings fed to its own assertReadOnlySql refusal checks, never executed",
    localOnly: false,
  },
};

const JS_UNSCOPED = /\.(deleteMany|updateMany)\(\s*(\{\s*\})?\s*\)/g;
// Every string / template literal (template holes kept as-is), scanned for raw SQL.
const LITERAL = /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
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

/** Source with comments blanked, so prose that mentions deleteMany({}) never counts. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function unscopedWrites(src: string): number {
  let n = (src.match(JS_UNSCOPED) ?? []).length;
  for (const lit of src.match(LITERAL) ?? []) {
    if (/\bDELETE\s+FROM\b/i.test(lit) && !/\bWHERE\b/i.test(lit)) n++;
    if (/\bTRUNCATE\s+(TABLE\s+)?["\w]/i.test(lit)) n++;
  }
  return n;
}

const scanned = scriptFiles(SCRIPTS).map((f) => {
  const rel = path.relative(SCRIPTS, f).replace(/\\/g, "/");
  const src = code(f);
  return { rel, src, unscoped: unscopedWrites(src) };
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

describe("#2421 import-zoho.js stays retired", () => {
  const src = fs.readFileSync(path.join(SCRIPTS, "import-zoho.js"), "utf8");

  it("loads no database driver and has no bulk write", () => {
    expect(src).not.toMatch(/require\([^)]*(@prisma|["'\/]pg["'])/);
    expect(unscopedWrites(code(path.join(SCRIPTS, "import-zoho.js")))).toBe(0);
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
