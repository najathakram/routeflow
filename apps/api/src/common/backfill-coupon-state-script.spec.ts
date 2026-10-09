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

  it("the dry run is the default: writing needs --apply AND --confirm-count", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--apply"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: "", STRIPE_SECRET_KEY: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--apply requires --confirm-count");
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

  it("prints tenant ids only - no slug, name or Stripe customer anywhere in the output code", () => {
    expect(code).not.toMatch(/\bslug\b/);
    expect(code).not.toMatch(/stripeCustomerId/);
  });
});
