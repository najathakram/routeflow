/**
 * Back-office P2 — static pin: where in `apps/api/src` a TENANT can be written TRIAL or have its
 * status rewritten.
 *
 * The rule "an ACTIVE tenant is never moved to TRIAL" (409 TENANT_TRIAL_EXTEND_NOT_ALLOWED) is
 * enforced in `PlatformAdminService.extendTrial` and `.updateStatus` (the status PATCH accepts any
 * TenantStatus). A NEW writer of `status: "TRIAL"` or a new file that updates `Tenant.status` is a
 * new way to demote a paying tenant, so it must show up here and be argued for, not slip in.
 *
 * Counts include read predicates (`where: { status: "TRIAL" }`) on purpose: moving one is cheap, the
 * point is that a change to this list gets a reviewer's eye.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") collect(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = collect(SRC_ROOT).map((file) => ({
  file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"),
  text: fs.readFileSync(file, "utf8"),
}));

function perFile(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SOURCES) {
    const n = s.text.match(new RegExp(re.source, "g"))?.length ?? 0;
    if (n > 0) out[s.file] = n;
  }
  return out;
}

describe("TRIAL / tenant-status write sites (back-office P2)", () => {
  it("scans a non-trivial tree (an empty scan would report green)", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it('`status: "TRIAL"` / `status: TenantStatus.TRIAL` appears only in the known files', () => {
    expect(perFile(/status:\s*(?:"TRIAL"|TenantStatus\.TRIAL)/)).toEqual({
      // createTenant (a new tenant starts on a trial), extendTrial (guarded), and the read predicates
      // of the at-risk / trial-count / expiring-trials stats.
      "platform-admin/platform-admin.service.ts": 6,
      // trial cancel: `where: { id, status: "TRIAL" }` (a predicate, not a write of TRIAL)
      "billing/subscription-mutation.service.ts": 1,
      "billing/mrr.service.ts": 1,
      // expire / warn crons: the warn predicates and expireTrials' compare-and-swap (`where: { id, status: "TRIAL" }`)
      "billing/billing-cron.service.ts": 3,
      // SA-775: expireTrials' scan predicate now lives in the one shared builder (cron + unpause preview)
      "billing/auto-lock-candidates.ts": 1,
      // self-signup creates the tenant in TRIAL
      "tenants/tenants.service.ts": 1,
    });
  });

  it("only these files update an existing Tenant's status (`tenant.update` / `updateMany`)", () => {
    const files = Object.keys(perFile(/\.tenant\.(?:update|updateMany)\(/)).sort();
    expect(files).toEqual([
      "billing/billing-cron.service.ts",
      "billing/billing.service.ts",
      // dunning: only moves readOnlyReason on an already READ_ONLY row (payment_overdue -> subscription_cancelled); never a TRIAL write
      "billing/dunning.service.ts",
      // SA-815a: the one plan-version pin writer sets Tenant.planVersionId only (no status)
      "billing/plan-version-pin.ts",
      "billing/subscription-mutation.service.ts",
      // the one transition-to-ACTIVE helper (clears readOnlyReason, closes the dunning clock); writes ACTIVE, never TRIAL
      "billing/transition-to-active.ts",
      "platform-admin/platform-admin.service.ts",
    ]);
  });

  it("the guarded paths carry the refusal code, and it is the same code on both server paths", () => {
    const svc = SOURCES.find((s) => s.file === "platform-admin/platform-admin.service.ts")!.text;
    // one helper builds the 409; extendTrial and updateStatus both call it
    expect(svc.match(/API_ERROR_CODES\.TENANT_TRIAL_EXTEND_NOT_ALLOWED/g)).toHaveLength(1);
    expect(svc.match(/throw activeTenantTrialRefusal\(\)/g)).toHaveLength(2);
  });
});
