import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LEGACY_ADDON_KEY_TO_SKU,
  SELF_SERVICE_ADDON_SKUS,
} from "../billing/plan-catalog.constants";

// SA-693 — the two owner-run scripts: report-addon-comp-candidates.mjs (READ-ONLY) and
// stamp-addon-comp.mjs (id-pinned, dry-run first). Neither is ever run against production from here;
// these pins read the files and spawn them only where no database is dialled.

const API_DIR = path.resolve(__dirname, "../..");
const REPORT = path.resolve(API_DIR, "scripts/report-addon-comp-candidates.mjs");
const STAMP = path.resolve(API_DIR, "scripts/stamp-addon-comp.mjs");
const reportSrc = fs.readFileSync(REPORT, "utf8");
const stampSrc = fs.readFileSync(STAMP, "utf8");

const codeOf = (src: string) =>
  src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
    .join("\n");

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

const noDb = () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(RAILWAY_|POSTGRES_|DATABASE_)/.test(k)) delete env[k];
  return env;
};

describe("report-addon-comp-candidates.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    expect(node([REPORT], noDb()).status).toBe(2);
  });

  it("is read-only: session read-only first, timeouts, and no write-capable SQL", () => {
    expect(reportSrc).toContain("SET default_transaction_read_only = on");
    expect(reportSrc).toContain("SET lock_timeout");
    expect(codeOf(reportSrc)).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/,
    );
  });

  it("goes through the shared report resolver, never DATABASE_URL directly", () => {
    expect(reportSrc).toContain("./lib/report-db-url.mjs");
    expect(codeOf(reportSrc)).not.toContain("DATABASE_URL");
  });

  it("selects exactly the candidate shape: active, item-less, $0, not already comp, self-serve SKUs", () => {
    expect(reportSrc).toContain("a.active = true");
    expect(reportSrc).toContain('a."stripeItemId" IS NULL');
    expect(reportSrc).toContain('COALESCE(a."priceSnapshot", 0) = 0');
    expect(reportSrc).toContain('a."isComp" = false');
  });

  it("reads the enabling actor from the latest addon.enabled BillingEvent, falling back to the ADDON_ENABLED audit row", () => {
    expect(reportSrc).toContain("e.type = 'addon.enabled'");
    expect(reportSrc).toContain('e."actorId"');
    expect(reportSrc).toContain("g.action = 'ADDON_ENABLED'");
  });

  it("never prints a tenant name, slug or user id: the slug is only the LIVE/TEST filter key", () => {
    const code = codeOf(reportSrc);
    expect(code).not.toMatch(/console\.\w+\([^)]*(slug|\.name|userId|actorId)/);
    // summarize() builds the printed detail from an explicit field list that has no slug
    const detail = code.slice(
      code.indexOf("const detail = rows.map"),
      code.indexOf("return { total"),
    );
    expect(detail).not.toMatch(/slug|name|userId|actorId/);
  });

  it("mirrors the self-serve SKU list and the legacy key map exactly", () => {
    const r = node(
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(REPORT).href)}).then(m=>console.log(JSON.stringify({s:m.SELF_SERVICE_ADDON_SKUS,l:m.LEGACY_ADDON_KEY_TO_SKU})))`,
      ],
      noDb(),
    );
    const got = JSON.parse(r.stdout.trim());
    expect(got.s).toEqual([...SELF_SERVICE_ADDON_SKUS]);
    expect(got.l).toEqual(LEGACY_ADDON_KEY_TO_SKU);
  });

  it("--self-test runs with no database", () => {
    const r = node([REPORT, "--self-test"], noDb());
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });
});

describe("stamp-addon-comp.mjs", () => {
  const ID = "00000000-0000-4000-8000-000000000001";

  it("refuses without --ids, and refuses a non-uuid id, before touching any database", () => {
    const a = node([STAMP], noDb());
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/--ids/);
    const b = node([STAMP, "--ids", "not-a-uuid"], noDb());
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/not a uuid/);
  });

  it("with a valid id but no database url it fails closed (exit 2), dry-run or apply", () => {
    expect(node([STAMP, "--ids", ID], noDb()).status).toBe(2);
    expect(node([STAMP, "--ids", ID, "--apply"], noDb()).status).toBe(2);
  });

  it("is a dry-run unless --apply: opens a READ ONLY transaction otherwise BEGIN, and has one UPDATE pinned by id", () => {
    const code = codeOf(stampSrc);
    expect(code).toContain('apply ? "BEGIN" : "BEGIN READ ONLY"');
    const updates = code.match(/UPDATE "/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(code).toMatch(/UPDATE "TenantAddon" SET "isComp" = true[\s\S]*WHERE id = \$1/);
    // never a table-wide write
    expect(code).not.toMatch(/DELETE|TRUNCATE|DROP|ALTER/);
  });

  it("writes an ADDON_COMPED AuditLog row per id with actor owner-stamp, in the same transaction", () => {
    expect(stampSrc).toContain("'ADDON_COMPED'");
    expect(stampSrc).toContain('const ACTOR = "owner-stamp"');
    expect(stampSrc.indexOf('INSERT INTO "AuditLog"')).toBeLessThan(stampSrc.indexOf('"COMMIT"'));
  });

  it("guards live tenants: --live-tenant-override plus a type-back phrase, and the test-tenant helper", () => {
    expect(stampSrc).toContain("test-tenants.cjs");
    expect(stampSrc).toContain("--live-tenant-override");
    expect(stampSrc).toMatch(/STAMP \$\{plan\.length\} ROWS/);
  });

  it("refusalFor refuses inactive, Stripe-billed, already-comp, priced and missing rows; passes only the candidate shape", async () => {
    const r = node(
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(STAMP).href)}).then(({refusalFor:f})=>{
          const ok={active:true,stripeItemId:null,isComp:false,priceSnapshot:0};
          console.log(JSON.stringify([
            f(ok), f({...ok,priceSnapshot:null}),
            f(undefined), f({...ok,active:false}), f({...ok,stripeItemId:"si_1"}),
            f({...ok,isComp:true}), f({...ok,priceSnapshot:12}),
          ]));
        })`,
      ],
      noDb(),
    );
    const [ok, okNull, missing, inactive, billed, comp, priced] = JSON.parse(r.stdout.trim());
    expect(ok).toBeNull();
    expect(okNull).toBeNull();
    expect(missing).toMatch(/not found/);
    expect(inactive).toMatch(/inactive/);
    expect(billed).toMatch(/Stripe item/);
    expect(comp).toMatch(/already a comp/);
    expect(priced).toMatch(/non-zero price/);
  });

  it("never prints a slug or name", () => {
    const code = codeOf(stampSrc);
    expect(code).not.toMatch(/console\.\w+\([^)]*(\.slug|\.name)\b/);
  });
});
