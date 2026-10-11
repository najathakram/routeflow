import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// SA-736r - apps/api/scripts/backfill-coupon-state.mjs. ONE WRITER: `--apply` goes through the compiled
// `applyCouponState` (the same code path the webhooks use), never its own SQL; the dry run is the default.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/backfill-coupon-state.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function runModule(js: string) {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; ${js}`,
    ],
    { cwd: API_DIR, encoding: "utf8", timeout: 60_000 },
  );
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout.trim());
}

describe("backfill-coupon-state.mjs", () => {
  it("structural: --apply calls applyCouponState from dist; no second writer of the coupon columns", () => {
    expect(code).toContain("state.applyCouponState(");
    expect(code).toContain('"dist", "billing", "coupon-state.js"');
    expect(code).not.toMatch(/\b(UPDATE|INSERT)\b/);
    expect(code).not.toMatch(/tenantSubscription\.(update|updateMany|upsert|create)\(/);
    expect(code).not.toMatch(/data:\s*\{[^}]*coupon/);
  });

  it("nit: money goes through @routeflow/pricing roundMoney, and the add-on sum reads billable rows with the ONE billableAddonWhere predicate", () => {
    expect(code).toMatch(/import \{[^}]*\broundMoney\b[^}]*\} from "@routeflow\/pricing"/);
    expect(code).not.toMatch(/const round2\b|Math\.round\(/);
    expect(code).toContain("billableAddonWhere(");
    expect(code).toContain('"dist", "billing", "addon-row.js"');
    // no hand-spelled comp filter beside it
    expect(code).not.toMatch(/isComp:\s*false/);
  });

  it("the dry run is the default: writing needs --apply AND --tenants AND --confirm-count", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--apply"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: "", STRIPE_SECRET_KEY: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--apply requires --tenants");
  });

  it("parseConfirmCount: a non-negative integer, at most once", () => {
    expect(
      runModule(`console.log(JSON.stringify(m.parseConfirmCount(["--confirm-count","3"])))`),
    ).toBe(3);
    expect(
      runModule(`console.log(JSON.stringify(m.parseConfirmCount(["--apply"]) ?? null))`),
    ).toBeNull();
    for (const bad of [
      `["--confirm-count"]`,
      `["--confirm-count","-1"]`,
      `["--confirm-count","x"]`,
    ]) {
      const r = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; m.parseConfirmCount(${bad});`,
        ],
        { cwd: API_DIR, encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
    }
  });

  it("planChanges: entering and leaving rows differ; unchanged and skipped rows do not; $0-but-not-full is report-only", () => {
    const out = runModule(`
      const rows = [
        { tenantId: "t-enter", stripeSubId: "sub_a", couponFull: false, couponId: null },
        { tenantId: "t-leave", stripeSubId: "sub_b", couponFull: true, couponId: "cp" },
        { tenantId: "t-same", stripeSubId: "sub_c", couponFull: true, couponId: "cp" },
        { tenantId: "t-ended", stripeSubId: "sub_d", couponFull: true, couponId: "cp" },
        { tenantId: "t-credit", stripeSubId: "sub_e", couponFull: false, couponId: null },
      ];
      const st = (full, couponId, previewTotalZero = false) => ({ kind: "state", state: { full, couponId, endsAt: null }, previewTotalZero });
      const readings = new Map([
        ["t-enter", st(true, "cp")],
        ["t-leave", st(false, null)],
        ["t-same", st(true, "cp")],
        ["t-ended", { kind: "skipped", why: "ended" }],
        ["t-credit", st(false, null, true)],
      ]);
      const p = m.planChanges(rows, readings);
      console.log(JSON.stringify({ changes: p.changes.map((c) => [c.tenantId, c.from, c.to]), skipped: p.skipped, zero: p.zeroButNotFull }));
    `);
    expect(out).toEqual({
      changes: [
        ["t-enter", false, true],
        ["t-leave", true, false],
      ],
      skipped: [{ tenantId: "t-ended", why: "ended" }],
      zero: ["t-credit"],
    });
  });

  it("prints tenant ids only: no console line carries a slug, a name or a Stripe customer", () => {
    const logLines = code
      .split(String.fromCharCode(10))
      .filter((l) => /console\.(log|error)/.test(l));
    expect(logLines.length).toBeGreaterThan(0);
    for (const l of logLines) expect(l).not.toMatch(/slug|stripeCustomerId|\.name/);
    expect(code).not.toMatch(/stripeCustomerId/);
  });

  it("review guard: parseTenantList is a non-empty de-duplicated allow-list, given at most once", () => {
    expect(
      runModule(`console.log(JSON.stringify(m.parseTenantList(["--tenants","a, b,a"])))`),
    ).toEqual(["a", "b"]);
    expect(
      runModule(`console.log(JSON.stringify(m.parseTenantList(["--apply"]) ?? null))`),
    ).toBeNull();
    for (const bad of [
      `["--tenants"]`,
      `["--tenants","--apply"]`,
      `["--tenants",","]`,
      `["--tenants","a","--tenants","b"]`,
    ]) {
      const r = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; m.parseTenantList(${bad});`,
        ],
        { cwd: API_DIR, encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
    }
  });

  it("review guard: checkApplyGuard fails closed - no list, a stranger id, a wrong count, a live row without the override", () => {
    const out = runModule(`
      const changes = [
        { tenantId: "t-test", from: false, to: true, live: false, delta: -99 },
        { tenantId: "t-live", from: true, to: false, live: true, delta: 149 },
      ];
      const g = (o) => m.checkApplyGuard({ changes, confirmCount: 1, liveOverride: false, ...o });
      const r = {
        noList: g({ tenants: undefined }).ok,
        empty: g({ tenants: [] }).ok,
        stranger: g({ tenants: ["t-other"] }).ok,
        wrongCount: g({ tenants: ["t-test"], confirmCount: 2 }).ok,
        liveNoOverride: g({ tenants: ["t-live"] }).ok,
        testOnly: g({ tenants: ["t-test"] }),
        liveOverride: g({ tenants: ["t-live"], liveOverride: true }),
        mixed: g({ tenants: ["t-test", "t-live"], confirmCount: 2, liveOverride: true }),
      };
      console.log(JSON.stringify({
        ...r,
        testOnly: [r.testOnly.ok, r.testOnly.phrase],
        liveOverride: [r.liveOverride.ok, r.liveOverride.phrase],
        mixed: [r.mixed.ok, r.mixed.phrase, r.mixed.selected.length],
      }));
    `);
    expect(out).toEqual({
      noList: false,
      empty: false,
      stranger: false,
      wrongCount: false,
      liveNoOverride: false,
      testOnly: [true, null],
      liveOverride: [true, "APPLY 1 LIVE"],
      mixed: [true, "APPLY 2 LIVE", 2],
    });
  });

  it("review guard: the TTY type-back - no TTY refuses, a wrong phrase refuses, the exact phrase passes; no phrase needs none", () => {
    const out = runModule(`
      const ask = (a) => async () => a;
      console.log(JSON.stringify([
        await m.typeBack(null, { isTTY: false }),
        await m.typeBack("APPLY 1 LIVE", { isTTY: false, ask: ask("APPLY 1 LIVE") }),
        await m.typeBack("APPLY 1 LIVE", { isTTY: true, ask: ask("apply 1 live") }),
        await m.typeBack("APPLY 1 LIVE", { isTTY: true, ask: ask("APPLY 1 LIVE") }),
      ]));
    `);
    expect(out).toEqual([true, false, false, true]);
  });

  it("review guard: the dry run shows each tenant's +/-X from the writer's own pricing (base + billable add-ons - discount)", () => {
    const out = runModule(`
      const rows = [
        { tenantId: "t1", stripeSubId: "s1", couponFull: false, couponId: null },
        { tenantId: "t2", stripeSubId: "s2", couponFull: true, couponId: "cp" },
        { tenantId: "t3", stripeSubId: "s3", couponFull: false, couponId: null },
      ];
      const st = (full) => ({ kind: "state", state: { full, couponId: full ? "cp" : null, endsAt: null }, previewTotalZero: false });
      const readings = new Map([["t1", st(true)], ["t2", st(false)], ["t3", st(true)]]);
      const pr = (over = {}) => ({ status: "ACTIVE", class: "PRODUCTION", planKey: "STARTER", basePriceSnapshot: 99, discount: 9, addonSum: 40, live: true, ...over });
      const p = m.planChanges(rows, readings, new Map([["t1", pr()], ["t2", pr({ live: false })], ["t3", pr({ status: "SUSPENDED" })]]));
      console.log(JSON.stringify(p.changes.map((c) => [c.tenantId, c.delta, c.live])));
    `);
    expect(out).toEqual([
      ["t1", -130, true],
      ["t2", 130, false],
      ["t3", 0, true],
    ]);
  });

  it("review guard: a tenant the script cannot classify is treated as LIVE (fail closed)", () => {
    const out = runModule(`
      const rows = [{ tenantId: "t1", stripeSubId: "s1", couponFull: false, couponId: null }];
      const readings = new Map([["t1", { kind: "state", state: { full: true, couponId: null, endsAt: null }, previewTotalZero: false }]]);
      console.log(JSON.stringify(m.planChanges(rows, readings).changes.map((c) => c.live)));
    `);
    expect(out).toEqual([true]);
  });
});
