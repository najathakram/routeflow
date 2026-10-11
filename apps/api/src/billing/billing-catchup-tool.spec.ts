import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-733 D7 — apps/api/scripts/billing-catchup.mjs and its pure core (scripts/lib/billing-catchup-core.cjs).
 * Never run against anything: the gate is exercised with fakes, and the script is only SPAWNED where it can not
 * reach a network (no credentials in the environment, or arguments refused before any request).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/billing-catchup.mjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("../../scripts/lib/billing-catchup-core.cjs");
const src = fs.readFileSync(SCRIPT, "utf8");

const report = (over: Record<string, unknown> = {}) => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantClass: "PRODUCTION",
  tenantStatus: "ACTIVE",
  eligible: true,
  ineligible: [],
  claimState: null,
  hasStripeSubscription: false,
  externalPayment: true,
  planKey: "GROWTH",
  priceSource: "catalog",
  monthlyCents: 31000,
  rfInvoices: { open: 1, paid: 0 },
  plan: {
    ok: true,
    shape: "trial_one_time",
    paidThrough: "2026-11-01T12:00:00.000Z",
    paidFromInvoices: true,
    anchorAt: "2026-11-01T12:00:00.000Z",
    trialEndAt: "2026-11-01T12:00:00.000Z",
    stub: {
      from: "2026-10-01T12:00:00.000Z",
      to: "2026-11-01T12:00:00.000Z",
      label: "Subscription — October 2026",
      lines: [{ kind: "PLAN", code: "PLAN", cents: 31000 }],
      totalCents: 31000,
      belowStripeMinimum: false,
    },
    voidInvoiceIds: ["inv_a"],
    unplaceableOpenIds: [],
    notes: [],
  },
  ...over,
});

const tty = { isTTY: true };
const noTty = { isTTY: false };

function gateInput(over: Record<string, unknown> = {}) {
  const ask = jest.fn(async () => "qa-acme");
  const parsed = core.parseArgs(["--tenant", "qa-acme", "--apply", "--backup-taken"]);
  return {
    args: parsed.args,
    report: report(),
    stdin: tty,
    stdout: tty,
    ask,
    guard: null,
    env: {},
    argv: ["--tenant", "qa-acme", "--apply", "--backup-taken"],
    ...over,
  };
}

describe("parseArgs", () => {
  it("a bare tenant is a dry-run", () => {
    const r = core.parseArgs(["--tenant", "qa-acme"]);
    expect(r.ok).toBe(true);
    expect(r.args).toMatchObject({ apply: false, tenant: "qa-acme", all: false });
  });

  it("--all is a dry-run only: --apply --all is refused at parse time", () => {
    expect(core.parseArgs(["--all"]).ok).toBe(true);
    expect(core.parseArgs(["--all", "--apply"])).toEqual({
      ok: false,
      error: "--apply is per tenant: --all is a dry-run only",
    });
  });

  it("refuses unknown flags, a missing value, a bad amount, both --tenant and --all, and nothing named", () => {
    expect(core.parseArgs(["--tenant", "x", "--force"]).ok).toBe(false);
    expect(core.parseArgs(["--tenant"]).ok).toBe(false);
    expect(core.parseArgs(["--tenant", "--apply"]).ok).toBe(false);
    expect(core.parseArgs(["--tenant", "x", "--apply", "--expected-cents", "3.5"]).ok).toBe(false);
    expect(core.parseArgs(["--tenant", "x", "--all"]).ok).toBe(false);
    expect(core.parseArgs([]).ok).toBe(false);
    expect(core.parseArgs(["--tenant", "x", "--expected-cents", "100"]).ok).toBe(false); // without --apply
  });

  it("reads the apply switches", () => {
    const r = core.parseArgs([
      "--tenant",
      "x",
      "--apply",
      "--backup-taken",
      "--live-tenant-override",
      "--expected-cents",
      "31000",
    ]);
    expect(r.args).toMatchObject({
      apply: true,
      backupTaken: true,
      liveOverride: true,
      expectedCents: 31000,
    });
  });
});

describe("the printed report (anonymised)", () => {
  it("prints price, the October line, RfInvoice state, the census and the verdict - no slug, no name", () => {
    const text = core.formatTenantReport(report()).join("\n");
    expect(text).toContain("tenant 11111111-1111-4111-8111-111111111111");
    expect(text).toContain("$310.00/month (catalog)");
    expect(text).toContain('"Subscription — October 2026" = $310.00');
    expect(text).toContain("1 open · 0 paid");
    expect(text).toContain("stripe subscription: no");
    expect(text).toContain("ELIGIBLE");
    expect(text).not.toMatch(/qa-acme|slug|name/i);
  });

  it("MF2: the dry-run prints the manual subscription's period beside the RfInvoice counts", () => {
    const text = core
      .formatTenantReport(
        report({
          subPeriod: { start: "2026-10-05T09:00:00.000Z", end: "2026-11-04T09:00:00.000Z" },
        }),
      )
      .join("\n");
    expect(text).toContain("sub period    2026-10-05 -> 2026-11-04");
  });

  it("a refused tenant says why; a plan that cannot be made says NEEDS RULING", () => {
    const t = core.formatTenantReport(
      report({
        eligible: false,
        ineligible: ["has_stripe_subscription"],
        hasStripeSubscription: true,
        plan: { ok: false, reason: "paid_after_gap" },
      }),
    );
    expect(t.join("\n")).toContain("refused: has_stripe_subscription");
    expect(t.join("\n")).toContain("CANNOT PLAN: paid_after_gap (NEEDS RULING)");
  });

  it("the census totals come first and flag tenants that already hold a Stripe subscription", () => {
    const lines = core
      .formatCensus({
        counts: {
          total: 3,
          planned: 3,
          failed: 0,
          eligible: 1,
          trialOneTime: 2,
          trial: 1,
          anchorNoLine: 0,
          needsRuling: 1,
          withStripeSubscription: 1,
          neitherManualNorStripe: 0,
          claimHeld: 0,
        },
        tenants: [report()],
        failed: [],
      })
      .join("\n");
    expect(lines.indexOf("census: 3")).toBe(0);
    expect(lines).toContain("trial+one-time 2");
    expect(lines).toContain("NEEDS RULING: tenants with a stripeSubId");
  });

  it("SA r-note (2): the census lists the refused tenants by ID and CODE (no names, no slugs), eligible ones not", () => {
    const refusedId = "22222222-2222-4222-8222-222222222222";
    const text = core
      .formatCensus({
        counts: {
          total: 2,
          planned: 2,
          failed: 0,
          eligible: 1,
          trialOneTime: 1,
          trial: 0,
          anchorNoLine: 0,
          needsRuling: 1,
          withStripeSubscription: 0,
          neitherManualNorStripe: 0,
          claimHeld: 0,
        },
        tenants: [
          report(),
          report({
            tenantId: refusedId,
            eligible: false,
            ineligible: ["billable_addon_not_card_billable"],
            refusals: ["CATCHUP_ADDON_NOT_CARD_BILLABLE"],
            plan: { ok: false, reason: "billable_addon_not_card_billable" },
          }),
        ],
        failed: [],
      })
      .join("\n");
    expect(text).toContain("refused tenants (route to the manual path)");
    expect(text).toContain(
      `  ${refusedId}  CATCHUP_ADDON_NOT_CARD_BILLABLE  (billable_addon_not_card_billable)`,
    );
    const list = text.slice(text.indexOf("refused tenants"), text.indexOf("tenant 1111"));
    expect(list).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(text).not.toMatch(/qa-acme|slug/i);
    // and the per-tenant verdict carries the code too
    expect(text).toContain("[CATCHUP_ADDON_NOT_CARD_BILLABLE]");
  });

  it("SA r-note 10-11: a legacy activation marker with no recorded period is listed by tenant id with its reason", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const text = core
      .formatCensus({
        counts: {
          total: 1,
          planned: 1,
          failed: 0,
          eligible: 0,
          trialOneTime: 0,
          trial: 0,
          anchorNoLine: 0,
          needsRuling: 1,
          withStripeSubscription: 0,
          neitherManualNorStripe: 0,
          claimHeld: 0,
        },
        tenants: [
          report({
            tenantId: id,
            eligible: false,
            ineligible: ["manual_marker_without_period"],
            refusals: ["CATCHUP_MANUAL_PERIOD_AHEAD"],
            plan: { ok: false, reason: "manual_marker_without_period" },
          }),
        ],
        failed: [],
      })
      .join("\n");
    expect(text).toContain(`  ${id}  CATCHUP_MANUAL_PERIOD_AHEAD  (manual_marker_without_period)`);
    expect(text).not.toMatch(/qa-acme|slug/i);
  });

  it("money() is integer arithmetic", () => {
    expect(core.money(31000)).toBe("$310.00");
    expect(core.money(5)).toBe("$0.05");
    expect(core.money(1999)).toBe("$19.99");
    expect(core.money(null)).toBe("n/a");
  });
});

describe("applyGate — every precondition, first failure wins, nothing asked before the cheap ones", () => {
  it("a test tenant with everything in order passes (no guard needed)", async () => {
    const i = gateInput();
    await expect(core.applyGate(i)).resolves.toEqual({ ok: true });
    expect(i.ask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not --apply", { args: core.parseArgs(["--tenant", "qa-acme"]).args }, /not an --apply run/],
    [
      "no --backup-taken",
      { args: core.parseArgs(["--tenant", "qa-acme", "--apply"]).args },
      /--backup-taken/,
    ],
    [
      "an ineligible tenant",
      { report: report({ eligible: false, ineligible: ["claim_held"] }) },
      /not eligible \(claim_held\)/,
    ],
    ["stdin not a terminal", { stdin: noTty }, /real terminal/],
    ["stdout not a terminal", { stdout: noTty }, /real terminal/],
    ["no dry-run report", { report: null }, /no dry-run report/],
  ])("%s => refused", async (_n, over, why) => {
    const i = gateInput(over);
    const r = await core.applyGate(i);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(why);
    expect(i.ask).not.toHaveBeenCalled(); // refused BEFORE it prompted
  });

  it("the slug must be typed back exactly", async () => {
    const i = gateInput({ ask: jest.fn(async () => "qa-acm") });
    expect(await core.applyGate(i)).toEqual({ ok: false, why: "the typed slug did not match" });
    const j = gateInput({ ask: jest.fn(async () => "  qa-acme  ") });
    expect((await core.applyGate(j)).ok).toBe(true); // surrounding whitespace only
  });

  it("--all can never apply", async () => {
    const i = gateInput({ args: { ...gateInput().args, all: true } });
    expect((await core.applyGate(i)).why).toMatch(/per tenant/);
  });
});

describe("a LIVE tenant fails closed unless the protected-tenant guard (#3344) is present", () => {
  const liveArgv = [
    "--tenant",
    "acme-foods",
    "--apply",
    "--backup-taken",
    "--live-tenant-override",
  ];
  const live = (over: Record<string, unknown> = {}) =>
    gateInput({
      args: core.parseArgs(liveArgv).args,
      argv: liveArgv,
      ask: jest.fn(async () => "acme-foods"),
      ...over,
    });

  it("without --live-tenant-override: refused", async () => {
    const argv = ["--tenant", "acme-foods", "--apply", "--backup-taken"];
    const r = await core.applyGate(live({ args: core.parseArgs(argv).args, argv }));
    expect(r.why).toMatch(/--live-tenant-override/);
  });

  it("with the override but NO guard module: refused (fail closed)", async () => {
    const r = await core.applyGate(live({ guard: null }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/protected-tenant guard \(#3344\) is not present/);
  });

  it("the shipped lib dir has no guard today: loadProtectedGuard returns null", () => {
    const hasGuard = fs.existsSync(path.join(API_DIR, "scripts/lib/live-target-guard.cjs"));
    const loaded = core.loadProtectedGuard(path.join(API_DIR, "scripts/lib"));
    expect(loaded === null).toBe(!hasGuard);
  });

  const makeGuard = (opts: { protectedTenant: boolean; mintFails?: boolean }) => {
    class ProtectedTenantError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "ProtectedTenantError";
      }
    }
    const token = Object.freeze({ tenantId: "11111111-1111-4111-8111-111111111111" });
    const live = {
      assertWritableTenant: jest.fn((_t: unknown, _s: unknown, _slugs: unknown, o: any) => {
        if (!opts.protectedTenant) return null;
        if (o?.allowProtected === token) return "paying";
        throw new ProtectedTenantError("tenant is protected (paying): refused");
      }),
      confirmProtectedOverride: jest.fn(async () => {
        if (opts.mintFails) throw new ProtectedTenantError("override refused");
        return token;
      }),
    };
    const slugs = { loadProtectedSlugs: jest.fn(() => new Set<string>(["acme-foods"])) };
    return { live, slugs };
  };

  it("guard present, tenant UNprotected: allowed", async () => {
    const guard = makeGuard({ protectedTenant: false });
    expect((await core.applyGate(live({ guard }))).ok).toBe(true);
    expect(guard.live.confirmProtectedOverride).not.toHaveBeenCalled();
  });

  it("guard present, tenant PROTECTED (paying): needs the guard's own override token, then passes", async () => {
    const guard = makeGuard({ protectedTenant: true });
    const r = await core.applyGate(live({ guard }));
    expect(r.ok).toBe(true);
    expect(guard.live.confirmProtectedOverride).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "11111111-1111-4111-8111-111111111111", argv: liveArgv }),
    );
  });

  it("guard present, tenant PROTECTED, override refused: refused, nothing passes", async () => {
    const guard = makeGuard({ protectedTenant: true, mintFails: true });
    const r = await core.applyGate(live({ guard }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/protected-tenant guard: override refused/);
  });

  it("an unreadable protected list (the guard throws) is a refusal, never a pass", async () => {
    const guard = makeGuard({ protectedTenant: false });
    guard.slugs.loadProtectedSlugs.mockImplementation(() => {
      throw new Error("PROTECTED_TENANT_SLUGS is not set");
    });
    const r = await core.applyGate(live({ guard }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/PROTECTED_TENANT_SLUGS is not set/);
  });

  it("a live slug never appears in a refusal message", async () => {
    const guard = makeGuard({ protectedTenant: true, mintFails: true });
    const r = await core.applyGate(live({ guard }));
    expect(JSON.stringify(r)).not.toContain("acme-foods");
  });
});

describe("the script", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["API_URL", "SUPER_ADMIN_USERNAME", "SUPER_ADMIN_PASSWORD"]) delete clean[k];
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...clean, ...env },
      timeout: 60_000,
    });
  };

  it("refuses --apply --all, an unknown flag and no tenant, before any credential or network", () => {
    for (const args of [["--all", "--apply"], ["--tenant", "x", "--bogus"], []]) {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/billing-catchup:/);
    }
  });

  it("a dry-run without super-admin credentials is an environment error (2), not a request", () => {
    const r = run(["--tenant", "qa-acme"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SUPER_ADMIN_USERNAME/);
  });

  it("source pins: no database client, no SQL writes; dry-run is a GET; the POST sits behind applyGate", () => {
    const code = src
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/from "pg"|require\("pg"\)|DATABASE_URL/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    const post = code.indexOf('"POST"');
    const gate = code.indexOf("core.applyGate");
    expect(gate).toBeGreaterThan(0);
    expect(post).toBeGreaterThan(gate); // the only POST comes after the gate
    expect(code.match(/"POST"/g)).toHaveLength(1);
    expect(code).toContain("catchup-checkout");
  });
});
