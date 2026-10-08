import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2639 / SA-547 — wipe-tenant-fresh-start refuses a PROTECTED target (paying, or linked to a Stripe
 * subscription) in every mode unless `--allow-paying-tenant`; with the flag, `--execute` also needs
 * the typed phrase `WIPE PAYING <slug>` after the slug type-back.
 *
 * Pure half: `checkProtectedTarget` / the parser, evaluated in a child node (the module is ESM).
 * Source half: the script reads the target's subscription from the SAME client and runs the guard
 * BEFORE any count or write, and asks the phrase AFTER the slug type-back and BEFORE the wipe.
 * The executed refusal/flag runs against a real database are F2's (qa-* tenants, a fake
 * stripeSubId only).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "wipe-tenant-fresh-start.js");
const LIB_HREF = pathToFileURL(path.join(API_DIR, "scripts", "lib", "fresh-start-target.mjs")).href;

const CASES = `
import * as t from "${LIB_HREF}";
const T = { id: "t-1", slug: "qa-2639", name: "QA 2639", status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
const check = (tenant, sub, allowPayingTenant) => t.checkProtectedTarget({ tenant, sub, allowPayingTenant, protectedSlugs: new Set() });
console.log(JSON.stringify({
  paying: check(T, { planKey: "STARTER", stripeSubId: null }, false),
  stripeOnly: check({ ...T, class: "TEST", status: "READ_ONLY" }, { planKey: null, stripeSubId: "sub_fake_qa" }, false),
  payingFlag: check(T, { planKey: "STARTER", stripeSubId: null }, true),
  plain: check({ ...T, class: "TEST" }, { planKey: "STARTER", stripeSubId: null }, false),
  noSub: check(T, null, false),
  deletedStripe: check({ ...T, class: "TEST", deletedAt: "2026-01-01" }, { planKey: null, stripeSubId: "sub_fake_qa" }, false),
  parse: t.parseFreshStartArgs(["qa-2639", "--local", "--allow-paying-tenant"]),
  parseDefault: t.parseFreshStartArgs(["qa-2639", "--local"]),
}));
`;

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

  it("a paying target without the flag is refused, naming the paying arm", () => {
    expect(r.paying.ok).toBe(false);
    expect(r.paying.reason).toMatch(/PAYING/);
    expect(r.paying.reason).toMatch(/tenant t-1 is protected/);
    expect(r.paying.reason).toMatch(/--allow-paying-tenant/);
  });

  it("the Stripe arm ALONE protects (TEST class, READ_ONLY, no planKey), naming Stripe", () => {
    expect(r.stripeOnly.ok).toBe(false);
    expect(r.stripeOnly.reason).toMatch(/Stripe/);
  });

  it("with --allow-paying-tenant the guard passes but demands the phrase WIPE PAYING <slug>", () => {
    expect(r.payingFlag).toMatchObject({ ok: true, phrase: "WIPE PAYING qa-2639" });
    expect(r.payingFlag.line).toMatch(/PROTECTED \(paying\)/);
  });

  it("an unprotected target is unchanged: ok, no phrase, no line", () => {
    for (const k of ["plain", "noSub", "deletedStripe"])
      expect(r[k]).toEqual({ ok: true, phrase: null, line: null });
  });

  it("SA-547a: no refusal names the tenant — id + arm only, never its slug or business name", () => {
    for (const k of ["paying", "stripeOnly"]) {
      expect(r[k].reason).not.toMatch(/qa-2639/);
      expect(r[k].reason).not.toMatch(/QA 2639/);
    }
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

  it("the parser accepts --allow-paying-tenant and defaults it off", () => {
    expect(r.parse.allowPayingTenant).toBe(true);
    expect(r.parseDefault.allowPayingTenant).toBe(false);
  });

  it("the script guards BEFORE any count/write, on the same client, and asks the phrase after the slug type-back", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect({ needle, found: i >= 0 }).toEqual({ needle, found: true });
      return i;
    };
    const subRead = at("prisma.tenantSubscription.findUnique(");
    const guard = at("checkProtectedTarget({");
    const counts = at("await countAll(tenant.id)");
    const slugTypeBack = at("await confirm(slug)");
    const phrase = at("await confirm(guard.phrase");
    const wipe = at("await nuke(tenant.id)");
    expect(subRead).toBeLessThan(guard);
    expect(guard).toBeLessThan(counts);
    expect(slugTypeBack).toBeLessThan(phrase);
    expect(phrase).toBeLessThan(wipe);
  });
});
