import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// S27c (units v2, owner Q3): apps/api/scripts/units-legacy-parent-census.mjs contract. A READ-ONLY count,
// per tenant, of legacy STANDARD parents that have variants and still sell. It is the count that Q3 / M7 wait
// for before any parent becomes a family. Read-only, counts only, tenant-scoped, and its text carries no
// write-shaped statement at all (EXECUTION-PLAN: the SA-795 (h) pin must not be able to flag it).

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/units-legacy-parent-census.mjs");
const exists = fs.existsSync(SCRIPT);
const source = exists ? fs.readFileSync(SCRIPT, "utf8") : "";

function node(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

/** Runs `expr` against the script's exports and returns its JSON-parsed result. */
function evalExports(expr: string) {
  const r = node([
    "--input-type=module",
    "-e",
    `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; console.log(JSON.stringify(${expr}));`,
  ]);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

const noDbEnv = (): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: "" };
  for (const k of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ])
    delete env[k];
  return env as NodeJS.ProcessEnv;
};

const row = (o: Record<string, unknown>) => ({
  tenant_key: "k1",
  children: 2,
  active_children: 2,
  sold_parent: false,
  sold_child: false,
  open_lines: false,
  has_stock: false,
  has_price: false,
  ...o,
});

describe("units-legacy-parent-census.mjs", () => {
  it("exists", () => {
    expect(exists).toBe(true);
  });

  describe("summarize (pure row aggregation)", () => {
    it("counts parents, children and each breakdown per tenant, with anonymous labels", () => {
      const rows = [
        row({
          tenant_key: "b",
          children: 3,
          active_children: 2,
          sold_parent: true,
          has_price: true,
        }),
        row({
          tenant_key: "b",
          children: 1,
          active_children: 1,
          sold_child: true,
          has_stock: true,
        }),
        row({ tenant_key: "b", sold_parent: true, sold_child: true, open_lines: true }),
        row({ tenant_key: "a", children: 5, active_children: 5, has_stock: true, has_price: true }),
      ];
      const r = evalExports(`m.summarize(${JSON.stringify(rows)})`);
      const byLabel = Object.fromEntries(r.tenants.map((t: { label: string }) => [t.label, t]));
      expect(Object.keys(byLabel)).toEqual(["tenant-1", "tenant-2"]);
      // keys sort, so "a" is tenant-1 and "b" is tenant-2
      expect(byLabel["tenant-1"]).toMatchObject({
        parents: 1,
        children: 5,
        activeChildren: 5,
        soldAsParent90: 0,
        soldAsChild90: 0,
        soldAsBoth90: 0,
        withStock: 1,
        withPrice: 1,
        withOpenLines: 0,
      });
      expect(byLabel["tenant-2"]).toMatchObject({
        parents: 3,
        children: 6,
        activeChildren: 5,
        soldAsParent90: 2,
        soldAsChild90: 2,
        soldAsBoth90: 1,
        withStock: 1,
        withPrice: 1,
        withOpenLines: 1,
      });
      expect(r.total).toMatchObject({
        parents: 4,
        children: 11,
        soldAsParent90: 2,
        soldAsChild90: 2,
        soldAsBoth90: 1,
        withStock: 2,
        withPrice: 2,
        withOpenLines: 1,
      });
    });

    it("never carries a tenant key or id out", () => {
      const r = evalExports(
        `m.summarize(${JSON.stringify([row({ tenant_key: "secret-key-1" })])})`,
      );
      expect(JSON.stringify(r)).not.toContain("secret-key-1");
    });

    it("counts parents whose children are all inactive as noActiveChildren", () => {
      const rows = [
        row({ children: 2, active_children: 0 }),
        row({ children: 1, active_children: 1 }),
        row({ tenant_key: "z", children: 3, active_children: 0 }),
      ];
      const r = evalExports(`m.summarize(${JSON.stringify(rows)})`);
      expect(r.total).toMatchObject({ parents: 3, noActiveChildren: 2 });
      expect(r.tenants[0]).toMatchObject({ noActiveChildren: 1 });
    });

    it("reports tenants scanned: the count passed in, else the tenants that had parents", () => {
      const rows = JSON.stringify([row({})]);
      expect(evalExports(`m.summarize(${rows}, 7)`).tenantsScanned).toBe(7);
      expect(evalExports(`m.summarize(${rows})`).tenantsScanned).toBe(1);
      expect(evalExports("m.summarize([], 4)")).toMatchObject({ tenants: [], tenantsScanned: 4 });
    });

    it("returns zeros and no tenants for no rows", () => {
      const r = evalExports("m.summarize([])");
      expect(r.tenants).toEqual([]);
      expect(r.total).toMatchObject({ parents: 0, children: 0, withStock: 0, soldAsBoth90: 0 });
    });
  });

  describe("formatTable", () => {
    it("prints one line per tenant plus a total, as plain text", () => {
      const out: string = evalExports(
        `m.formatTable(m.summarize(${JSON.stringify([row({ sold_parent: true })])}))`,
      );
      expect(out).toMatch(/tenant-1/);
      expect(out).toMatch(/TOTAL/);
      expect(out).toMatch(/tenants scanned: 1/);
      expect(out).toMatch(/no-active/);
      expect(out.split("\n").length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("parseArgs", () => {
    it("needs exactly one of --tenant <slug> or --all", () => {
      expect(evalExports(`m.parseArgs(["--tenant","acme"])`)).toMatchObject({
        tenant: "acme",
        all: false,
      });
      expect(evalExports(`m.parseArgs(["--all","--json"])`)).toMatchObject({
        tenant: null,
        all: true,
        json: true,
      });
      const bad = (a: string) =>
        evalExports(
          `(() => { try { m.parseArgs(${a}); return "no throw"; } catch (e) { return e.message; } })()`,
        );
      expect(bad(`[]`)).toMatch(/--tenant/);
      expect(bad(`["--all","--tenant","acme"]`)).toMatch(/not both|either/i);
      expect(bad(`["--tenant"]`)).toMatch(/--tenant/);
    });
  });

  describe("process behaviour", () => {
    it("--self-test passes with no database", () => {
      const res = node([SCRIPT, "--self-test"], noDbEnv());
      expect(res.stderr).toBe("");
      expect(res.stdout.trim()).toBe("self-test ok");
      expect(res.status).toBe(0);
    });

    it("exits 2 with no scope argument, before connecting", () => {
      const res = node([SCRIPT], noDbEnv());
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
    });

    it("exits 2 with no database url configured, before connecting", () => {
      const res = node([SCRIPT, "--tenant", "acme"], noDbEnv());
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
    });
  });

  describe("static pins on the script text", () => {
    // The whole file, comments included: nothing write-shaped may appear anywhere.
    it("contains no write, DDL or lock-taking token, even in comments", () => {
      expect(source).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|UPSERT|MERGE|VACUUM|REINDEX)\b/i,
      );
      expect(source).not.toMatch(/\bFOR\s+(UPDATE|SHARE|NO\s+KEY)\b/i);
      expect(source).not.toMatch(
        /\$executeRaw|\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
      );
    });

    it("its only SET statements are the read-only session ones, issued before any other query", () => {
      const sets = [...source.matchAll(/["'`]\s*SET\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
      expect(sets).toEqual(["default_transaction_read_only", "statement_timeout", "lock_timeout"]);
      expect(source).toContain('"SET default_transaction_read_only = on"');
      const firstQuery = source.search(/\.query\(/);
      expect(source.slice(firstQuery)).toMatch(
        /^\.query\("SET default_transaction_read_only = on"\)/,
      );
    });

    it("scopes every table it reads to the tenant", () => {
      const sql: string = evalExports("m.CENSUS_SQL");
      for (const alias of ["p", "c", "o", "i"]) {
        expect(sql).toMatch(new RegExp(`\\b${alias}\\."tenantId"`));
      }
      expect(sql).toMatch(/\$1/);
    });

    it("--all covers PRODUCTION tenants only; a named --tenant is not class-filtered", () => {
      for (const name of ["CENSUS_SQL", "TENANT_COUNT_SQL"]) {
        const sql: string = evalExports(`m.${name}`);
        expect(sql).toContain(`($1::text IS NOT NULL OR t.class = 'PRODUCTION')`);
      }
    });

    it("selects no slug, business name or email (counts out, scope in)", () => {
      const sql: string = evalExports("m.CENSUS_SQL");
      const selectList = sql.slice(0, sql.search(/\bFROM\b/i));
      expect(selectList).not.toMatch(/slug|email|businessName|\bname\b/i);
    });

    it("names no real tenant: acme is the only example slug", () => {
      expect(source).toMatch(/acme/);
    });
  });
});
