import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2437 — the Stripe live-cutover purge: apps/api/scripts/purge-test-stripe-ids.mjs and its pure
 * planner scripts/lib/stripe-test-purge.mjs.
 *
 * Both are ESM and this suite runs under ts-jest's CommonJS transform, so the planner is driven
 * through ONE `node --input-type=module` child that runs every case and prints one JSON line, and
 * the script's gates are exercised by spawning the REAL script with NO database variables: each
 * refusal here must happen before any connection attempt.
 */

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/purge-test-stripe-ids.mjs");
const LIB_HREF = pathToFileURL(path.resolve(API_DIR, "scripts/lib/stripe-test-purge.mjs")).href;

const NO_CONNECTION_ATTEMPT = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|Cannot find module/i;

function noDbEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "DATABASE_URL" ||
      key === "STRIPE_SECRET_KEY" ||
      key.startsWith("RAILWAY_") ||
      key.startsWith("POSTGRES_") ||
      key.startsWith("PG")
    ) {
      delete env[key];
    }
  }
  return env;
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...noDbEnv(), ...env },
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
  return { status: res.status, out };
}

const PLANNER_CASES = `
import * as p from "${LIB_HREF}";
const subs = [
  { id: "s1", tenantId: "t1", stripeCustomerId: "cus_T", stripeSubId: "sub_T" },
  { id: "s2", tenantId: "t2", stripeCustomerId: "cus_MISSING", stripeSubId: null },
  { id: "s3", tenantId: "t3", stripeCustomerId: "cus_LIVE", stripeSubId: "sub_T2" },
];
const addons = [{ id: "a1", tenantId: "t1", stripePriceId: "price_T", stripeItemId: "si_ERR" }];
const connects = [
  { id: "c1", tenantId: "t1", stripeAccountId: "acct_1", livemode: false, disconnectedAt: null },
  { id: "c2", tenantId: "t2", stripeAccountId: "acct_2", livemode: false, disconnectedAt: "2026-01-01" },
  { id: "c3", tenantId: "t3", stripeAccountId: "acct_3", livemode: true, disconnectedAt: null },
  { id: "c4", tenantId: "t4", stripeAccountId: null, livemode: false, disconnectedAt: null },
];
const verdict = new Map([
  ["cus_T", "test"], ["sub_T", "test"], ["sub_T2", "test"], ["price_T", "test"],
  ["cus_LIVE", "live"], ["si_ERR", "error"],
]);
const plan = p.buildPlan({ subscriptions: subs, addons, connects }, verdict);
const ids = p.idsToVerify({ subscriptions: subs, addons });
const cleanPlan = p.buildPlan({ subscriptions: [subs[0]], addons: [], connects: [] }, verdict);
const ok = { apply: true, backupTaken: true, confirm: "1" };
console.log(JSON.stringify({
  keys: ["sk_test_x", "rk_test_x", "sk_live_x", "rk_live_x", "", "pk_test_x", undefined].map(p.classifyKey),
  ids: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v].sort()])),
  plan,
  count: p.confirmationCount(plan),
  args: [
    p.parseArgs([]),
    p.parseArgs(["--apply", "--backup-taken", "--confirm", "7", "--local"]),
    p.parseArgs(["--aply"]),
    p.parseArgs(["--confirm"]),
    p.parseArgs(["--confirm", "--apply"]),
    p.parseArgs(["--exclude-tenant", "acme,globex", "--exclude-tenant", "acme"]),
    p.parseArgs(["--exclude-tenant", "acme,"]),
    p.parseArgs(["--exclude-tenant"]),
  ],
  exclusion: (() => {
    const r = p.resolveExclusions(["acme", "nope"], [{ id: "t1", slug: "acme" }, { id: "t2", slug: "globex" }]);
    const kept = p.withoutExcluded({ subscriptions: subs, addons, connects }, r.ids);
    const excludedPlan = p.buildPlan(kept, verdict);
    return {
      ids: [...r.ids],
      unknown: r.unknown,
      touched: [...new Set(excludedPlan.changes.map((c) => c.tenantId))].sort(),
      rows: [kept.subscriptions.length, kept.addons.length, kept.connects.length],
    };
  })(),
  refusals: {
    live: p.applyRefusal({ args: ok, keyMode: "live", plan: cleanPlan }),
    none: p.applyRefusal({ args: ok, keyMode: "none", plan: cleanPlan }),
    liveIds: p.applyRefusal({ args: ok, keyMode: "test", plan }),
    noBackup: p.applyRefusal({ args: { ...ok, backupTaken: false }, keyMode: "test", plan: cleanPlan }),
    wrongCount: p.applyRefusal({ args: { ...ok, confirm: "2" }, keyMode: "test", plan: cleanPlan }),
    pass: p.applyRefusal({ args: ok, keyMode: "test", plan: cleanPlan }),
  },
}));
`;

describe("stripe-test-purge planner (#2437)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  beforeAll(() => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", PLANNER_CASES], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    r = JSON.parse(res.stdout.trim());
  });

  it("classifies secret and restricted keys; anything else is none", () => {
    expect(r.keys).toEqual(["test", "test", "live", "live", "none", "none", "none"]);
  });

  it("collects every stored id by kind for verification", () => {
    expect(r.ids).toEqual({
      customer: ["cus_LIVE", "cus_MISSING", "cus_T"],
      subscription: ["sub_T", "sub_T2"],
      price: ["price_T"],
      item: ["si_ERR"],
    });
  });

  it("clears only ids the test account verified, field by field", () => {
    const byId = Object.fromEntries(r.plan.changes.map((c: { id: string }) => [c.id, c]));
    expect(byId.s1.clear).toEqual({ stripeCustomerId: "cus_T", stripeSubId: "sub_T" });
    expect(byId.s2).toBeUndefined(); // missing: not proven test, never cleared
    expect(byId.s3.clear).toEqual({ stripeSubId: "sub_T2" }); // the live customer is kept
    expect(byId.a1.clear).toEqual({ stripePriceId: "price_T" }); // the errored item is kept
  });

  it("lists unproven ids as skipped and reports live ids", () => {
    const skipped = r.plan.skipped.map((s: { value: string; verdict: string }) => [
      s.value,
      s.verdict,
    ]);
    expect(skipped).toEqual([
      ["cus_MISSING", "missing"],
      ["cus_LIVE", "live"],
      ["si_ERR", "error"],
    ]);
    expect(r.plan.liveIds).toEqual(["cus_LIVE"]);
  });

  it("disconnects only active test-mode Connect rows, keeping the account id", () => {
    const connect = r.plan.changes.filter(
      (c: { model: string }) => c.model === "TenantStripeConnect",
    );
    expect(connect).toEqual([
      {
        model: "TenantStripeConnect",
        id: "c1",
        tenantId: "t1",
        clear: {},
        set: { disconnectedAt: "now", chargesEnabled: false },
        stripeAccountId: "acct_1",
      },
    ]);
    expect(r.count).toBe(String(r.plan.changes.length));
  });

  it("parses argv strictly", () => {
    expect(r.args[0]).toEqual({
      apply: false,
      local: false,
      backupTaken: false,
      help: false,
      confirm: null,
      excludeTenants: [],
      allowProtected: [],
    });
    expect(r.args[1]).toEqual({
      apply: true,
      local: true,
      backupTaken: true,
      help: false,
      confirm: "7",
      excludeTenants: [],
      allowProtected: [],
    });
    expect(r.args[2].error).toMatch(/unknown argument: --aply/);
    expect(r.args[3].error).toMatch(/--confirm needs a value/);
    expect(r.args[4].error).toMatch(/--confirm needs a value/);
    expect(r.args[5].excludeTenants).toEqual(["acme", "globex"]);
    expect(r.args[6].error).toMatch(/empty slug/);
    expect(r.args[7].error).toMatch(/--exclude-tenant needs a value/);
  });

  it("row 195: --allow-protected is repeatable and per tenant; a protected tenant is asserted before the transaction opens", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require("node:fs")
      .readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const confirm = src.indexOf("confirmProtectedOverride({");
    const assertAt = src.indexOf("assertWritableTenant(t, t, protectedSlugs");
    const begin = src.indexOf('client.query("BEGIN")');
    expect(confirm).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(confirm);
    expect(begin).toBeGreaterThan(assertAt);
  });

  it("drops every row of an excluded tenant before planning; unknown slugs are reported", () => {
    expect(r.exclusion.ids).toEqual(["t1"]);
    expect(r.exclusion.unknown).toEqual(["nope"]);
    expect(r.exclusion.rows).toEqual([2, 0, 3]); // t1's subscription, add-on and Connect row gone
    expect(r.exclusion.touched).not.toContain("t1");
  });

  it("refuses --apply without a test key, with live ids, without a backup or the exact count", () => {
    expect(r.refusals.live).toMatch(/LIVE key/);
    expect(r.refusals.none).toMatch(/missing/);
    expect(r.refusals.liveIds).toMatch(/livemode: refusing/);
    expect(r.refusals.noBackup).toMatch(/--backup-taken/);
    expect(r.refusals.wrongCount).toMatch(/--confirm 1/);
    expect(r.refusals.pass).toBeNull();
  });
});

describe("purge-test-stripe-ids.mjs gates (#2437), no database env", () => {
  it("prints usage for --help and exits 0", () => {
    const { status, out } = runScript(["--help"]);
    expect(status).toBe(0);
    expect(out).toMatch(/Usage:/);
  });

  it("refuses an unknown flag with exit 2", () => {
    const { status, out } = runScript(["--aply"]);
    expect(status).toBe(2);
    expect(out).toMatch(/unknown argument: --aply/);
  });

  it("refuses a live key before touching any database", () => {
    const { status, out } = runScript([], { STRIPE_SECRET_KEY: "sk_live_notreal" });
    expect(status).toBe(1);
    expect(out).toMatch(/LIVE key/);
  });

  it("refuses --apply without a test key", () => {
    const { status, out } = runScript(["--apply", "--backup-taken", "--confirm", "0"]);
    expect(status).toBe(1);
    expect(out).toMatch(/--apply needs STRIPE_SECRET_KEY/);
  });

  it("never falls back to a stray target: no proxy variables means a refusal", () => {
    const { status, out } = runScript([], {
      STRIPE_SECRET_KEY: "sk_test_notreal",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/none",
    });
    expect(status).toBe(1);
    expect(out).toMatch(/Missing Railway proxy variables/);
    expect(out).toMatch(/never falls back to DATABASE_URL/);
  });
});
