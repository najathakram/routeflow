import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_MODULE_KEYS } from "../billing/business-profiles";
import { LEGACY_ADDON_KEY_TO_SKU } from "../billing/plan-catalog.constants";

// SA-769 (D-S2) - the owner-run, READ-ONLY census of the "old shape": tenants whose earlier business
// profile apply wrote GRANT overrides for the fleet modules instead of comp rows. Those overrides
// stay (they are already unbilled and access is unchanged); converting them to comp rows is a
// follow-up (dry-run first, owner yes per live tenant) and is NOT built here. The script is never
// run against production from an implementation session: these pins read the file and spawn it only
// where no database is dialled.

const API_DIR = path.resolve(__dirname, "../..");
const REPORT = path.resolve(API_DIR, "scripts/report-profile-grant-overrides.mjs");
const reportSrc = fs.readFileSync(REPORT, "utf8");

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

describe("report-profile-grant-overrides.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    expect(node([REPORT], noDb()).status).toBe(2);
  });

  it("is read-only: session read-only first, timeouts, and no write-capable SQL", () => {
    expect(reportSrc).toContain("SET default_transaction_read_only = on");
    expect(reportSrc).toContain("SET statement_timeout");
    expect(reportSrc).toContain("SET lock_timeout");
    expect(reportSrc.indexOf("default_transaction_read_only")).toBeLessThan(
      reportSrc.indexOf('FROM "TenantFeatureOverride"'),
    );
    expect(codeOf(reportSrc)).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b(?!['"])/,
    );
  });

  it("goes through the shared report resolver, never DATABASE_URL directly", () => {
    expect(reportSrc).toContain("./lib/report-db-url.mjs");
    expect(codeOf(reportSrc)).not.toContain("DATABASE_URL");
  });

  it("selects exactly the old shape: an ACTIVE GRANT override on a profile module", () => {
    expect(reportSrc).toContain("o.effect = 'GRANT'");
    expect(reportSrc).toContain('o."revokedAt" IS NULL');
    expect(reportSrc).toContain('o."expiresAt" IS NULL OR o."expiresAt" > now()');
    expect(reportSrc).toContain('o."featureKey" = ANY($1::text[])');
  });

  it("classifies a profile apply through its BUSINESS_PROFILE_APPLIED audit row; the reason prefix is only a secondary signal and unknown is not called hand-made", () => {
    // the controller writes `dto.reason?.trim() || resolved.reason`: a custom reason hides the prefix
    expect(reportSrc).toContain("g.action = 'BUSINESS_PROFILE_APPLIED'");
    expect(reportSrc).toContain("jsonb_array_elements(COALESCE(g.meta -> 'plan' -> 'overrides'");
    expect(reportSrc).toContain("e ->> 'effect' = 'GRANT'");
    expect(reportSrc).toContain("e ->> 'action' IN ('create', 'replace')");
    expect(reportSrc).toContain('g."tenantId" = o."tenantId"');
    expect(reportSrc).toContain("auditMatch");
    expect(reportSrc).toContain("prefixMatch");
    const code = codeOf(reportSrc);
    expect(code).toMatch(
      /auditMatch === true \|\| r\.prefixMatch === true \? "profile-apply" : "unknown"/,
    );
    expect(code).not.toContain("handMade");
    expect(code).toMatch(/LIMITS: origin=unknown is NOT proof of a hand-made override/);
  });

  it("prints tenant id, module and override id only: never a name, slug, email, user id or the free-text reason", () => {
    const code = codeOf(reportSrc);
    expect(code).not.toMatch(/\bt\.(slug|name)\b|"createdById"|\bemail\b/);
    // the reason is free text an admin typed: it may classify a row, it is never selected for output
    expect(code).not.toMatch(/SELECT[^;]*o\.reason\s*(,|\n)/);
    // the mapped output rows and the summary built from them: everything printed
    const printed = code.slice(code.indexOf("const rows"), code.indexOf("if (json)"));
    expect(printed.length).toBeGreaterThan(100);
    expect(printed).not.toMatch(/slug|name|reason|userId|actorId|createdById/);
  });

  it("mirrors PROFILE_MODULE_KEYS exactly, and none of them is a legacy-bridged add-on key", () => {
    const r = node(
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(REPORT).href)}).then(m=>console.log(JSON.stringify(m.PROFILE_MODULE_KEYS)))`,
      ],
      noDb(),
    );
    expect(JSON.parse(r.stdout.trim())).toEqual([...PROFILE_MODULE_KEYS]);
    for (const k of PROFILE_MODULE_KEYS) expect(LEGACY_ADDON_KEY_TO_SKU[k]).toBeUndefined();
  });

  it("--self-test runs with no database", () => {
    const r = node([REPORT, "--self-test"], noDb());
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });
});
