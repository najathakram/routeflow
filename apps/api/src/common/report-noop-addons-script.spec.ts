import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LEGACY_ADDON_KEY_TO_SKU,
  SELF_SERVICE_ADDON_SKUS,
  ALWAYS_ENFORCED_PLAN_KEYS,
} from "../billing/plan-catalog.constants";
import { DARK_PLAN_FLAGS } from "../billing/plan-flag-policy";

// SA-1099 §6 (WP5, R23 / T23) — apps/api/scripts/report-noop-addons.mjs contract. Read-only, ids and counts only:
// fails closed without a database url, carries no write SQL, keeps its mirrors equal to their API sources, and never
// lets a slug reach its output. The row-level behaviour on a real database is report-noop-addons.db.spec.ts.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-noop-addons.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

function codeLines(): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

const mirrorList = (name: string): string[] => {
  const m = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

describe("report-noop-addons.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT, "--enforcement", "off"], env).status).toBe(2);
  });

  it("refuses a bad --enforcement value before any connection", () => {
    const r = node([SCRIPT, "--enforcement", "maybe"], process.env);
    expect(r.status).toBe(2);
  });

  // SA-1099 A-3 note 4 (R-2): the courtesy depends on the production switch, so a run that quietly assumed "off"
  // could list the wrong rows. The flag is required; the refusal comes before any connection and prints no rows.
  it("R-2: no --enforcement flag exits 2 with the instruction and prints no rows (before any connection)", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // reachable only if the script connected: nothing may listen here
      DATABASE_URL: "postgresql://nobody:none@127.0.0.1:1/none",
    };
    for (const args of [[SCRIPT], [SCRIPT, "--json"], [SCRIPT, "--enforcement"]]) {
      const r = node(args, env);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(
        "Pass --enforcement on or --enforcement off (the PLAN_FLAG_ENFORCEMENT value in production).",
      );
    }
  });

  it("sets the session read-only, caps lock and statement time, and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET lock_timeout");
    expect(source).toContain("SET statement_timeout");
    // 'GRANT' as a quoted VALUE (the override effect read since SA-1099 A-3) is not the SQL statement GRANT
    const sql = codeLines()
      .join("\n")
      .replace(/(["'])GRANT\1/g, "");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("calls no write script and names no API service (T23: no write calls)", () => {
    const imports = codeLines().filter((l) => /^import |require\(/.test(l));
    expect(imports.join("\n")).not.toMatch(/stamp-addon-comp|credit|refund|prod-migrate|stripe/i);
  });

  it("--self-test runs when spawned by its real path", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^self-test ok \(\d+ shared cases\)$/);
  });

  it("--self-test runs EVERY case of the shared table (the same file the API parity spec reads)", () => {
    const table = JSON.parse(
      fs.readFileSync(
        path.resolve(API_DIR, "../../scripts/fixtures/noop-addon-cases.json"),
        "utf8",
      ),
    );
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.stdout.trim()).toBe(`self-test ok (${table.cases.length} shared cases)`);
  });

  it("mirrors SELF_SERVICE_ADDON_SKUS, LEGACY_ADDON_KEY_TO_SKU, DARK_PLAN_FLAGS and ALWAYS_ENFORCED_PLAN_KEYS exactly", () => {
    expect(mirrorList("SELF_SERVICE_ADDON_SKUS")).toEqual([...SELF_SERVICE_ADDON_SKUS]);
    expect(mirrorList("ALWAYS_ENFORCED_PLAN_KEYS").sort()).toEqual(
      [...ALWAYS_ENFORCED_PLAN_KEYS].sort(),
    );
    const dark = [...DARK_PLAN_FLAGS].sort();
    expect(mirrorList("DARK_PLAN_FLAGS").sort()).toEqual(dark);
    const block = source.match(/export const LEGACY_ADDON_KEY_TO_SKU = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const legacy = Object.fromEntries(
      [...block![1].matchAll(/(\w+):\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(legacy).toEqual(LEGACY_ADDON_KEY_TO_SKU);
  });

  it("the pre-pin dark set is a subset of the dark list and equals plan-flag-policy's PREPIN set", () => {
    const policy = fs.readFileSync(
      path.resolve(API_DIR, "src/billing/plan-flag-policy.ts"),
      "utf8",
    );
    const block = policy.match(/const PREPIN_DARK_FLAGS[^=]*= new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const fromPolicy = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(mirrorList("PREPIN_DARK_FLAGS").sort()).toEqual(fromPolicy);
  });

  it("summarize labels nothing by slug and never echoes one", () => {
    const rows = [
      {
        id: "r1",
        tenantId: "11111111-aaaa",
        slug: "acme",
        sku: "FORECASTING",
        quantity: 1,
        why: { "flag.forecasting": "courtesy" },
      },
      {
        id: "r2",
        tenantId: "22222222-bbbb",
        slug: "globex",
        sku: "FORECASTING",
        quantity: 1,
        why: { "flag.forecasting": "plan" },
      },
    ];
    const r = node(
      [
        "--input-type=module",
        "-e",
        `import { summarize } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
          `console.log(JSON.stringify(summarize(${JSON.stringify(rows)})));`,
      ],
      process.env,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/acme|globex/);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ total: 2, tenants: 2, bySku: { FORECASTING: 2 } });
  });
});
