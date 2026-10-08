import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2639 / SA-547 + row 195 — wipe-tenant-fresh-start refuses a PROTECTED target (paying, linked to a
 * Stripe subscription, or named in PROTECTED_TENANT_SLUGS) in every mode unless
 * `--allow-protected <tenantId> --backup-taken` AND a typed `ALLOW PROTECTED <tenantId>` at a real
 * terminal (live-target-guard.cjs confirmProtectedOverride). `--allow-paying-tenant` is retired.
 *
 * Pure half: `checkProtectedTarget` / the parser, evaluated in a child node (the module is ESM).
 * Process half: the script itself run as a child, up to the point it would dial (nothing dials).
 * Source half: the script reads the target's subscription from the SAME client and runs the guard
 * BEFORE any count or write. The executed refusal against a real database is F2's (qa-* tenants,
 * a fake stripeSubId only).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "wipe-tenant-fresh-start.js");
const LIB_HREF = pathToFileURL(path.join(API_DIR, "scripts", "lib", "fresh-start-target.mjs")).href;

const CASES = `
import * as t from "${LIB_HREF}";
const T = { id: "t-1", slug: "acme-2639", name: "Acme 2639", status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
const LISTED = new Set(["acme-2639"]);
const check = (tenant, sub, protectedSlugs = new Set()) => t.checkProtectedTarget({ tenant, sub, protectedSlugs });
console.log(JSON.stringify({
  paying: check(T, { planKey: "STARTER", stripeSubId: null }),
  stripeOnly: check({ ...T, class: "TEST", status: "READ_ONLY" }, { planKey: null, stripeSubId: "sub_fake_qa" }),
  envListed: check({ ...T, status: "TRIAL" }, null, LISTED),
  envListedDeleted: check({ ...T, status: "TRIAL", deletedAt: "2026-01-01" }, null, LISTED),
  plain: check({ ...T, class: "TEST" }, { planKey: "STARTER", stripeSubId: null }),
  noSub: check(T, null),
  deletedStripe: check({ ...T, class: "TEST", deletedAt: "2026-01-01" }, { planKey: null, stripeSubId: "sub_fake_qa" }),
  parse: t.parseFreshStartArgs(["acme-2639", "--local", "--allow-protected", "t-1", "--backup-taken"]),
  parseDefault: t.parseFreshStartArgs(["acme-2639", "--local"]),
  parseRetired: t.parseFreshStartArgs(["acme-2639", "--local", "--allow-paying-tenant"]),
  parseNoValue: t.parseFreshStartArgs(["acme-2639", "--allow-protected"]),
}));
`;

// A live-path invocation that stops (exit 1) at the protected-slugs load, before any connection.
const PROXY_ENV = {
  POSTGRES_USER: "u",
  POSTGRES_PASSWORD: "p",
  POSTGRES_DB: "railway",
  RAILWAY_TCP_PROXY_DOMAIN: "proxy.example.net",
  RAILWAY_TCP_PROXY_PORT: "5432",
};
const runScript = (args: string[], env: Record<string, string>) => {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("PROTECTED_") && !k.startsWith("DATABASE")) clean[k] = v;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...clean, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
};
const LIVE = ["acme-2639", "--live-tenant-override", "--exclude-tenant", "acme-other"];

describe("#2639 wipe-tenant-fresh-start refuses a protected target", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  beforeAll(() => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", CASES], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    r = JSON.parse(res.stdout.trim());
  });

  it("a paying target is refused, naming the paying arm and the new override", () => {
    expect(r.paying).toMatchObject({ protected: true, arm: "paying" });
    expect(r.paying.reason).toMatch(/PAYING/);
    expect(r.paying.reason).toMatch(/tenant t-1 is protected/);
    expect(r.paying.reason).toMatch(/--allow-protected <tenantId>/);
    expect(r.paying.reason).not.toMatch(/--allow-paying-tenant/);
  });

  it("the Stripe arm ALONE protects (TEST class, READ_ONLY, no planKey), naming Stripe", () => {
    expect(r.stripeOnly).toMatchObject({ protected: true, arm: "stripe-linked" });
    expect(r.stripeOnly.reason).toMatch(/Stripe/);
  });

  it("row 195: an env-listed TRIAL tenant (no plan, no Stripe) is protected", () => {
    expect(r.envListed).toMatchObject({ protected: true, arm: "env-listed" });
    expect(r.envListed.reason).toMatch(/PROTECTED_TENANT_SLUGS/);
  });

  it("row 195: a soft-deleted env-listed tenant is STILL protected", () => {
    expect(r.envListedDeleted).toMatchObject({ protected: true, arm: "env-listed" });
  });

  it("an unprotected target is unchanged", () => {
    for (const k of ["plain", "noSub", "deletedStripe"])
      expect(r[k]).toEqual({ protected: false, arm: null, reason: null });
  });

  it("SA-547a: no refusal names the tenant — id + arm only, never its slug or business name", () => {
    for (const k of ["paying", "stripeOnly", "envListed"]) {
      expect(r[k].reason).not.toMatch(/acme-2639/);
      expect(r[k].reason).not.toMatch(/Acme 2639/);
    }
  });

  it("--allow-paying-tenant is retired: an unknown argument; --allow-protected needs a value", () => {
    expect(r.parseRetired).toEqual({ error: "unknown argument: --allow-paying-tenant" });
    expect(r.parseNoValue).toEqual({ error: "--allow-protected needs a tenant id" });
    expect(r.parse).toMatchObject({ allowProtected: "t-1", backupTaken: true });
    expect(r.parseDefault.allowProtected).toBeNull();
  });

  it("the script exits 2 on --allow-paying-tenant before touching anything", () => {
    const res = runScript(["acme-2639", "--local", "--allow-paying-tenant"], {});
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown argument: --allow-paying-tenant/);
  });

  it("row 195: unset PROTECTED_TENANT_SLUGS on a non-local target is refused before any dial", () => {
    const res = runScript(LIVE, PROXY_ENV);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/PROTECTED_TENANT_SLUGS is not set/);
    expect(res.stdout + res.stderr).not.toMatch(/acme-2639/);
  });

  it.each([
    ["an invalid entry", "acme foods"],
    ["a test-pattern slug", "qa-foods"],
    ["a duplicate", "acme-foods,acme-foods"],
  ])("row 195: %s in PROTECTED_TENANT_SLUGS refuses everything, printing no slug", (_l, value) => {
    const res = runScript(LIVE, { ...PROXY_ENV, PROTECTED_TENANT_SLUGS: value });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/PROTECTED_TENANT_SLUGS entry/);
    expect(res.stdout + res.stderr).not.toMatch(/acme-2639|acme foods|qa-foods|acme-foods/);
  });

  it("HIGH-2 source: no output of the wipe script or its target module interpolates a tenant NAME", () => {
    const lib = path.join(API_DIR, "scripts", "lib", "fresh-start-target.mjs");
    for (const f of [SCRIPT, lib]) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect({ f, hit: /\$\{[^}]*\b(?:tenant|t)\.name\b/.test(src) }).toEqual({ f, hit: false });
    }
  });

  // F2's real-PG run on 7d14d7ec: both scripts read TenantSubscription."stripeSubscriptionId", which does
  // not exist (the column is stripeSubId), so every tenant crashed. A mocked unit cannot see that, so
  // this pins every column the scripts READ against the Prisma schema itself.
  it("schema: every Tenant / TenantSubscription column the two scripts read exists in the Prisma schema", () => {
    const schemaDir = path.join(API_DIR, "prisma", "schema");
    const columnsOf = (file: string, model: string) => {
      const body =
        new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(
          readFileSync(path.join(schemaDir, file), "utf8"),
        )?.[1] ?? "";
      return new Set(
        body
          .split("\n")
          .map((l) => l.trim().split(/\s+/)[0])
          .filter((n) => /^[a-z]\w*$/.test(n)),
      );
    };
    const sub = columnsOf("platform.prisma", "TenantSubscription");
    const tenant = columnsOf("tenancy.prisma", "Tenant");
    expect(sub.size).toBeGreaterThan(5); // vacuity: the model was really parsed
    expect(tenant.size).toBeGreaterThan(5);

    // b294's PROTECTION_SQL: t.<col> / t."<col>" and s."<col>".
    const b294 = readFileSync(
      path.join(API_DIR, "scripts", "backfill-b294-order-line-taxrate.mjs"),
      "utf8",
    );
    const sql = /const PROTECTION_SQL = `([\s\S]*?)`/.exec(b294)?.[1] ?? "";
    const sCols = [...sql.matchAll(/\bs\."(\w+)"/g)].map((m) => m[1]);
    const tCols = [...sql.matchAll(/\bt\.(?:"(\w+)"|(\w+))/g)].map((m) => m[1] ?? m[2]);
    // Vacuity by COUNT, never by re-typing names (SA: the schema is the only source of the names).
    expect(sCols.length).toBeGreaterThanOrEqual(2);
    expect(tCols.length).toBeGreaterThanOrEqual(4);
    for (const c of sCols) expect({ c, exists: sub.has(c) }).toEqual({ c, exists: true });
    for (const c of tCols) expect({ c, exists: tenant.has(c) }).toEqual({ c, exists: true });

    // The wipe's tenantSubscription.findUnique select keys.
    const wipe = readFileSync(SCRIPT, "utf8");
    const sel =
      /tenantSubscription\.findUnique\(\{[\s\S]*?select: \{([^}]*)\}/.exec(wipe)?.[1] ?? "";
    const keys = [...sel.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) expect({ k, exists: sub.has(k) }).toEqual({ k, exists: true });
  });

  it("the script guards BEFORE any count/write, on the same client, via a real assertWritableTenant call", () => {
    const src = readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect({ needle, found: i >= 0 }).toEqual({ needle, found: true });
      return i;
    };
    const subRead = at("prisma.tenantSubscription.findUnique(");
    const guard = at("checkProtectedTarget({");
    const override = at("confirmProtectedOverride({");
    const assert = at("assertWritableTenant(tenant, sub, protectedSlugs");
    const counts = at("await countAll(tenant.id)");
    const slugTypeBack = at("await confirm(slug)");
    const wipe = at("await nuke(tenant.id)");
    expect(subRead).toBeLessThan(guard);
    expect(guard).toBeLessThan(override);
    expect(override).toBeLessThan(assert);
    expect(assert).toBeLessThan(counts);
    expect(slugTypeBack).toBeLessThan(wipe);
  });
});
