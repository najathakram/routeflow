import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-733r11 (row 385) - PHASE 1 red rows for the operator tool apps/api/scripts/billing-correct-activation.mjs and
 * its pure core scripts/lib/billing-correct-activation-core.cjs (script-spec style of billing-catchup-tool.spec.ts:
 * the gate is exercised with fakes; the script is only SPAWNED where it cannot reach a network or a database).
 * Everything is RED on master 5a938f0a2 (neither file exists).
 *
 * NEW SYMBOLS ASSUMED (phase 2 must use these names or change the rows):
 *   core.parseArgs(argv) -> { ok, args | error }   flags: --tenant <slug> [--void-coverage <markerId>]
 *        [--restore-coverage <markerId>] [--billing-start <YYYY-MM-DD>] [--reason <text>] [--apply] [--backup-taken] [--live-tenant-override]
 *        [--owner-approved] [--json] [--self-test] [--help]; args fields: tenant, apply, backupTaken, liveOverride,
 *        ownerApproved, billingStart, voidCoverage
 *   core.validateBillingStart("2026-10-01") -> { ok: true, billingStart: Date } | { ok: false, error }
 *   core.formatDryRun(report) -> string[]   report = { tenantId, claimState, markers: [{ id, action, periodStart,
 *        periodEnd, voided }], before: S, after: S } with S = { floor, paidThrough, s, a, stubCents, voidInvoiceIds }
 *        (ISO strings, integer cents)
 *   core.applyGate({ args, report, stdin, stdout, ask, guard, env, argv }) -> { ok: true, ownerApprovedAt } |
 *        { ok: false, why }   (the shape of billing-catchup-core.cjs applyGate)
 * The scripts-live-target-guard.spec.ts exempt map / guard-call pin must be updated by the implementation phase.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/billing-correct-activation.mjs");
const CORE = path.resolve(API_DIR, "scripts/lib/billing-correct-activation-core.cjs");
const loadCore = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(CORE);
};
const read = (p: string) => fs.readFileSync(p, "utf8");

const TENANT = "11111111-1111-4111-8111-111111111111";
const tty = { isTTY: true };
const noTty = { isTTY: false };

const report = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  tenantClass: "PRODUCTION",
  tenantStatus: "ACTIVE",
  claimState: null,
  markers: [
    {
      id: "marker-act-1",
      action: "TENANT_MANUAL_ACTIVATION_MARKER",
      periodStart: "2026-10-12T04:08:24.000Z",
      periodEnd: "2026-11-11T04:08:24.000Z",
      voided: true,
    },
  ],
  before: {
    floor: "2026-10-12T04:08:24.000Z",
    paidThrough: "2026-11-11T04:08:24.000Z",
    s: "2026-11-11T04:08:24.000Z",
    a: "2026-12-01T12:00:00.000Z",
    stubCents: 6776,
    voidInvoiceIds: ["inv_dec_open"],
  },
  after: {
    floor: "2026-10-01T12:00:00.000Z",
    paidThrough: "2026-10-01T12:00:00.000Z",
    s: "2026-10-01T12:00:00.000Z",
    a: "2026-11-01T12:00:00.000Z",
    stubCents: 10000,
    voidInvoiceIds: ["inv_oct_open", "inv_nov_open"],
  },
  ...over,
});

const APPLY_ARGV = [
  "--tenant",
  "qa-acme",
  "--void-coverage",
  "marker-act-1",
  "--billing-start",
  "2026-10-01",
  "--apply",
  "--backup-taken",
  "--owner-approved",
];
function gateInput(over: Record<string, unknown> = {}, argv: string[] = APPLY_ARGV) {
  const parsed = loadCore().parseArgs(argv);
  return {
    args: parsed.args,
    report: report(),
    stdin: tty,
    stdout: tty,
    ask: jest.fn(async () => "qa-acme"),
    guard: null,
    env: {},
    argv,
    ...over,
  };
}

describe("the files exist and the script is safe by construction", () => {
  it("RED: --self-test runs the pure checks without a database or a network and exits 0", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/self-test/i);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/FAIL/);
  });

  it("RED: it never calls Stripe - no stripe import, client, key or API host in the script or its core", () => {
    for (const file of [SCRIPT, CORE]) {
      const src = read(file);
      expect(src).not.toMatch(/from\s+["']stripe["']|require\(["']stripe["']\)/);
      expect(src).not.toMatch(/StripeService|new Stripe\(|api\.stripe\.com|STRIPE_SECRET/);
    }
  });

  it("RED: it only APPENDS audit rows - no UPDATE / DELETE of an AuditLog row anywhere (the original markers are never edited)", () => {
    for (const file of [SCRIPT, CORE]) {
      const src = read(file);
      expect(src).not.toMatch(/UPDATE\s+"?AuditLog|DELETE\s+FROM\s+"?AuditLog/i);
      expect(src).not.toMatch(/auditLog\.(update|updateMany|delete|deleteMany|upsert)\b/);
    }
    expect(read(SCRIPT)).toMatch(/INSERT\s+INTO\s+"?AuditLog|auditLog\.create/i);
  });

  it("RED: it writes only the three correction actions (void, restore, billing-start override)", () => {
    const src = read(SCRIPT) + read(CORE);
    expect(src).toContain("TENANT_MANUAL_ACTIVATION_COVERAGE_VOID");
    expect(src).toContain("TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE");
    expect(src).toContain("TENANT_BILLING_START_OVERRIDE");
  });

  it("RED: the live-target guard is called for real (assertWritableTenant / assertSafeTarget) before any write", () => {
    expect(read(SCRIPT) + read(CORE)).toMatch(/assertWritableTenant\(|assertSafeTarget\(/);
  });

  it("N11: the tool REFUSES while a claim is held - the source re-reads catchupState under the Tenant lock and throws before any INSERT", () => {
    const src = read(SCRIPT);
    const refusal = src.search(/if \(held\) throw refuse\(/);
    const insert = src.search(/INSERT\s+INTO\s+"?AuditLog/i);
    expect(refusal).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(refusal);
    expect(src.slice(0, refusal)).toMatch(/FOR UPDATE/); // the lock is taken before the claim is read
  });
});

describe("RED: billing start validation - an anchor 1st at 12:00Z and not before go-live", () => {
  it.each([
    ["2026-10-01", "2026-10-01T12:00:00.000Z"],
    ["2026-11-01", "2026-11-01T12:00:00.000Z"],
    ["2027-01-01", "2027-01-01T12:00:00.000Z"],
  ])("%s is accepted as %s", (input, iso) => {
    const r = loadCore().validateBillingStart(input);
    expect(r.ok).toBe(true);
    expect(r.billingStart.toISOString()).toBe(iso);
  });

  it.each([
    ["not a 1st", "2026-10-15"],
    ["before go-live (Sep 1)", "2026-09-01"],
    ["before go-live (Oct 1 00:00Z is not the 12:00Z boundary)", "2026-10-01T00:00:00Z"],
    ["not a date", "soon"],
    ["empty", ""],
  ])("%s (%s) is refused with a reason", (_n, input) => {
    const r = loadCore().validateBillingStart(input);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});

describe("RED: parseArgs - dry-run by default, one tenant, at least one action", () => {
  it("a bare tenant with an action is a dry-run (apply false), both actions parse", () => {
    const r = loadCore().parseArgs([
      "--tenant",
      "qa-acme",
      "--void-coverage",
      "marker-act-1",
      "--billing-start",
      "2026-10-01",
    ]);
    expect(r.ok).toBe(true);
    expect(r.args).toMatchObject({ apply: false, tenant: "qa-acme" });
    expect(JSON.stringify(r.args)).toContain("marker-act-1");
    expect(JSON.stringify(r.args)).toContain("2026-10-01");
  });

  it("refuses: no tenant, no action, an unknown flag, a missing value, --apply without a tenant", () => {
    const core = loadCore();
    expect(core.parseArgs(["--billing-start", "2026-10-01"]).ok).toBe(false);
    expect(core.parseArgs(["--tenant", "qa-acme"]).ok).toBe(false);
    expect(
      core.parseArgs(["--tenant", "qa-acme", "--billing-start", "2026-10-01", "--force"]).ok,
    ).toBe(false);
    expect(core.parseArgs(["--tenant", "qa-acme", "--void-coverage"]).ok).toBe(false);
    expect(core.parseArgs(["--apply", "--billing-start", "2026-10-01"]).ok).toBe(false);
  });

  it("an invalid --billing-start is refused at parse time (nothing to apply)", () => {
    expect(loadCore().parseArgs(["--tenant", "qa-acme", "--billing-start", "2026-10-15"]).ok).toBe(
      false,
    );
  });

  it("reads the apply switches", () => {
    const r = loadCore().parseArgs([...APPLY_ARGV, "--live-tenant-override"]);
    expect(r.args).toMatchObject({
      apply: true,
      backupTaken: true,
      liveOverride: true,
      ownerApproved: true,
    });
  });
});

describe("RED: the dry-run prints the before / after the owner decides on - ids and numbers, never a name", () => {
  const text = () => loadCore().formatDryRun(report()).join("\n");

  it("names the tenant by id and lists the activation markers with their windows (and which are voided)", () => {
    expect(text()).toContain(TENANT);
    expect(text()).toContain("marker-act-1");
    expect(text()).toContain("2026-10-12");
    expect(text()).toContain("2026-11-11");
    expect(text()).toMatch(/void/i);
  });

  it("shows floor / paidThrough / S / A / the stub BEFORE vs AFTER", () => {
    const t = text();
    expect(t).toMatch(/before/i);
    expect(t).toMatch(/after/i);
    expect(t).toContain("$67.76"); // before
    expect(t).toContain("$100.00"); // after
    expect(t).toContain("2026-10-01"); // the corrected floor / S
    expect(t).toContain("2026-11-01"); // the corrected A
  });

  it("lists the OPEN RfInvoices the eventual settle would void", () => {
    expect(text()).toContain("inv_oct_open");
    expect(text()).toContain("inv_nov_open");
  });

  it("carries no slug or name, and says nothing is written", () => {
    expect(text()).not.toMatch(/qa-acme|slug/i);
    expect(text()).toMatch(/dry-run|nothing (was )?written|no changes/i);
  });
});

describe("RED: --apply gate - every precondition, the first failure wins, a dry-run writes nothing", () => {
  it("a test tenant with everything in order passes and RECORDS the owner's approval time", async () => {
    const i = gateInput();
    const r = await loadCore().applyGate(i);
    expect(r.ok).toBe(true);
    expect(Number.isNaN(Date.parse(r.ownerApprovedAt))).toBe(false);
    expect(i.ask).toHaveBeenCalledTimes(1);
  });

  it("a dry-run (no --apply) is never an apply: refused, nothing asked", async () => {
    const i = gateInput(
      {},
      APPLY_ARGV.filter((a) => a !== "--apply"),
    );
    const r = await loadCore().applyGate(i);
    expect(r.ok).toBe(false);
    expect(i.ask).not.toHaveBeenCalled();
  });

  it.each([
    ["no --backup-taken", APPLY_ARGV.filter((a) => a !== "--backup-taken"), {}, /backup/i],
    ["no owner approval", APPLY_ARGV.filter((a) => a !== "--owner-approved"), {}, /owner/i],
    ["stdin not a terminal", APPLY_ARGV, { stdin: noTty }, /terminal/i],
    ["stdout not a terminal", APPLY_ARGV, { stdout: noTty }, /terminal/i],
    ["no dry-run report", APPLY_ARGV, { report: null }, /report/i],
  ])("%s => refused before anything is written", async (_n, argv, over, why) => {
    const i = gateInput(over, argv);
    const r = await loadCore().applyGate(i);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(why);
  });

  it("the slug must be typed back exactly", async () => {
    const r = await loadCore().applyGate(gateInput({ ask: jest.fn(async () => "qa-acm") }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/slug|typed/i);
  });

  it.each(["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"])(
    "a held catch-up claim (%s) is refused (claimRefusal): the markers would change a plan that is in flight",
    async (state) => {
      const r = await loadCore().applyGate(gateInput({ report: report({ claimState: state }) }));
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/claim|catch-up/i);
    },
  );

  it("a LIVE tenant (a non-test slug) needs --live-tenant-override", async () => {
    const argv = APPLY_ARGV.map((a) => (a === "qa-acme" ? "acme-shop" : a));
    const r = await loadCore().applyGate(
      gateInput({ ask: jest.fn(async () => "acme-shop") }, argv),
    );
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/live-tenant-override/);
  });

  it("... and with the override but WITHOUT the protected-tenant guard it fails closed (assertSafeTarget / assertWritableTenant)", async () => {
    const argv = [...APPLY_ARGV, "--live-tenant-override"].map((a) =>
      a === "qa-acme" ? "acme-shop" : a,
    );
    const r = await loadCore().applyGate(
      gateInput({ ask: jest.fn(async () => "acme-shop"), guard: null }, argv),
    );
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/guard/i);
  });
});

describe("RED (SA-733r12): --restore-coverage <markerId> has the same gates as --void-coverage", () => {
  const RESTORE_ARGV = [
    "--tenant",
    "qa-acme",
    "--restore-coverage",
    "marker-act-1",
    "--apply",
    "--backup-taken",
    "--owner-approved",
  ];

  it("parses as an action of its own (a dry-run by default) and satisfies the 'at least one action' rule", () => {
    const r = loadCore().parseArgs(RESTORE_ARGV.filter((a) => a !== "--apply"));
    expect(r.ok).toBe(true);
    expect(r.args.apply).toBe(false);
    expect(JSON.stringify(r.args)).toContain("marker-act-1");
    expect(loadCore().parseArgs(["--tenant", "qa-acme", "--restore-coverage"]).ok).toBe(false);
  });

  it("a void and a restore of the SAME marker in one run is refused (they would cancel out)", () => {
    expect(
      loadCore().parseArgs([
        "--tenant",
        "qa-acme",
        "--void-coverage",
        "marker-act-1",
        "--restore-coverage",
        "marker-act-1",
      ]).ok,
    ).toBe(false);
  });

  it("a test tenant with everything in order passes the apply gate and records the owner's approval time", async () => {
    const r = await loadCore().applyGate(gateInput({}, RESTORE_ARGV));
    expect(r.ok).toBe(true);
    expect(Number.isNaN(Date.parse(r.ownerApprovedAt))).toBe(false);
  });

  it.each([
    ["no --backup-taken", RESTORE_ARGV.filter((a) => a !== "--backup-taken"), {}, /backup/i],
    ["no owner approval", RESTORE_ARGV.filter((a) => a !== "--owner-approved"), {}, /owner/i],
    ["no terminal", RESTORE_ARGV, { stdin: noTty }, /terminal/i],
    [
      "a wrong slug typed back",
      RESTORE_ARGV,
      { ask: jest.fn(async () => "qa-acm") },
      /slug|typed/i,
    ],
    [
      "a held claim",
      RESTORE_ARGV,
      { report: report({ claimState: "AWAITING_FIRST_PAYMENT" }) },
      /claim|catch-up/i,
    ],
  ])("%s => refused", async (_n, argv, over, why) => {
    const r = await loadCore().applyGate(gateInput(over, argv));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(why);
  });

  it("a LIVE tenant needs --live-tenant-override and the guard, exactly as for a void", async () => {
    const argv = RESTORE_ARGV.map((a) => (a === "qa-acme" ? "acme-shop" : a));
    const ask = jest.fn(async () => "acme-shop");
    const noOverride = await loadCore().applyGate(gateInput({ ask }, argv));
    expect(noOverride.ok).toBe(false);
    expect(noOverride.why).toMatch(/live-tenant-override/);
    const noGuard = await loadCore().applyGate(
      gateInput({ ask, guard: null }, [...argv, "--live-tenant-override"]),
    );
    expect(noGuard.ok).toBe(false);
    expect(noGuard.why).toMatch(/guard/i);
  });

  it("the dry-run prints the marker's state before and after (voided -> counts again) and writes nothing", () => {
    const text = loadCore()
      .formatDryRun(
        report({
          markers: [
            {
              id: "marker-act-1",
              action: "TENANT_MANUAL_ACTIVATION_MARKER",
              periodStart: "2026-10-12T04:08:24.000Z",
              periodEnd: "2026-11-11T04:08:24.000Z",
              voided: true,
              restoredAfter: true,
            },
          ],
        }),
      )
      .join("\n");
    expect(text).toContain("marker-act-1");
    expect(text).toMatch(/restor/i);
    expect(text).toMatch(/before/i);
    expect(text).toMatch(/after/i);
    expect(text).not.toMatch(/qa-acme|slug/i);
  });
});

describe("N3: the preview says how it priced the line", () => {
  it("prints 'price $X (override|snapshot), add-ons excluded - preview only; the catch-up dry-run is the authority'", () => {
    const core = loadCore();
    const t = core
      .formatDryRun(report({ pricing: { cents: 10000, source: "override" } }))
      .join("\n");
    expect(t).toMatch(
      /price \$100\.00 \(override\), add-ons excluded - preview only; the catch-up dry-run is the authority/,
    );
    const u = core
      .formatDryRun(report({ pricing: { cents: 24900, source: "snapshot" } }))
      .join("\n");
    expect(u).toMatch(/price \$249\.00 \(snapshot\)/);
    const none = core.formatDryRun(report({ pricing: null })).join("\n");
    expect(none).toMatch(/price n\/a/);
  });
});

describe("N4: the tool asserts the compiled marker semantics version after loading dist", () => {
  it("catchup-markers.ts exports CATCHUP_MARKERS_VERSION and the core expects the same number", () => {
    const ts = read(path.resolve(__dirname, "catchup-markers.ts"));
    const m = ts.match(/export const CATCHUP_MARKERS_VERSION = (\d+)/);
    expect(m).not.toBeNull();
    expect(loadCore().EXPECTED_MARKERS_VERSION).toBe(Number(m![1]));
  });

  it("assertMarkersVersion passes on a match and fails loudly on a mismatch or a missing export", () => {
    const core = loadCore();
    const v = core.EXPECTED_MARKERS_VERSION;
    expect(() => core.assertMarkersVersion({ CATCHUP_MARKERS_VERSION: v })).not.toThrow();
    expect(() => core.assertMarkersVersion({ CATCHUP_MARKERS_VERSION: v + 1 })).toThrow(/version/i);
    expect(() => core.assertMarkersVersion({})).toThrow(/version/i);
    expect(() => core.assertMarkersVersion(null)).toThrow(/version/i);
  });

  it("the script calls it right after loading the compiled module", () => {
    expect(read(SCRIPT)).toMatch(/assertMarkersVersion\(/);
  });
});
