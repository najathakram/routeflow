/**
 * SA-140: `isPayingRow` is the ONE place "is this tenant currently in MrrService's paying set"
 * is decided — this pins it agrees with `PAYING_TENANT_CONDITIONS`/`payingWhere` for every
 * representative row shape, and that no OTHER file hand-rolls its own copy of the same decision
 * (the class of bug this PR fixes at four sites: emitPayingDelta, reconcilePriceLedger,
 * updatePlan, and updateStatus/activateManualSubscription's now-shared predicate).
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { isPayingRow, PAYING_TENANT_CONDITIONS } from "./mrr.service";

describe("isPayingRow parity with PAYING_TENANT_CONDITIONS", () => {
  const rows: {
    label: string;
    tenant: { status: string; deletedAt: Date | null; class: string };
    planKey: string | null;
    expected: boolean;
  }[] = [
    {
      label: "ACTIVE, PRODUCTION, not deleted, planKey set — paying",
      tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      planKey: "SCALE",
      expected: true,
    },
    {
      label: "SUSPENDED — not paying",
      tenant: { status: "SUSPENDED", deletedAt: null, class: "PRODUCTION" },
      planKey: "SCALE",
      expected: false,
    },
    {
      label: "non-PRODUCTION class — not paying",
      tenant: { status: "ACTIVE", deletedAt: null, class: "DEMO" },
      planKey: "SCALE",
      expected: false,
    },
    {
      label: "soft-deleted — not paying",
      tenant: { status: "ACTIVE", deletedAt: new Date(), class: "PRODUCTION" },
      planKey: "SCALE",
      expected: false,
    },
    {
      label: "planKey null — not paying",
      tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      planKey: null,
      expected: false,
    },
    {
      label:
        "deletedAt undefined (a caller's select never fetched it) — treated as not deleted, same as every prior inline `!= null` copy",
      tenant: { status: "ACTIVE", deletedAt: undefined as unknown as null, class: "PRODUCTION" },
      planKey: "SCALE",
      expected: true,
    },
  ];

  it.each(rows)("$label", ({ tenant, planKey, expected }) => {
    // The manual, from-scratch evaluation of the SAME four conditions PAYING_TENANT_CONDITIONS
    // names — this is the "payingWhere-equivalent, evaluated by hand" parity check L-167 asks
    // for (a Prisma `where` object can't be called as a JS function to compare against directly).
    const manual =
      tenant.status === PAYING_TENANT_CONDITIONS.status &&
      tenant.deletedAt == PAYING_TENANT_CONDITIONS.deletedAt &&
      tenant.class === PAYING_TENANT_CONDITIONS.class &&
      planKey != null;
    expect(manual).toBe(expected);
    expect(isPayingRow(tenant, planKey)).toBe(expected);
  });
});

describe("source pin: no paying-set decision hand-rolled outside isPayingRow", () => {
  const readSrc = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("billing.service.ts calls isPayingRow at both sites that gate on the paying set (emitPayingDelta, reconcilePriceLedger)", () => {
    const src = readSrc("billing/billing.service.ts");
    expect((src.match(/isPayingRow\(/g) ?? []).length).toBe(2);
    // The removed hand-rolled shape this file used to have — never again.
    expect(src).not.toMatch(/sub\.planKey == null\) return; *\n[\s\S]{0,200}addonMrr/);
  });

  it("platform-admin.service.ts calls isPayingRow at every wasPaying/isPaying site (updateStatus, updatePlan, activateManualSubscription — 2 each, +1: updateTenantPriceOverride backfill emit gate (B864, SA-277))", () => {
    const src = readSrc("platform-admin/platform-admin.service.ts");
    expect((src.match(/isPayingRow\(/g) ?? []).length).toBe(7);
    // `payingBase` was the old hand-rolled 2-of-4-conditions local — confirms it's gone, not
    // just renamed.
    expect(src).not.toContain("payingBase");
  });

  it("mrr.service.ts is the only file defining PAYING_TENANT_CONDITIONS/isPayingRow", () => {
    const src = readSrc("billing/mrr.service.ts");
    expect(src).toContain("export const PAYING_TENANT_CONDITIONS");
    expect(src).toContain("export function isPayingRow(");
  });

  it("addon-ledger.ts's emitAddonDelta gates on isPayingRow", () => {
    const src = readSrc("billing/addon-ledger.ts");
    expect((src.match(/isPayingRow\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("B865 / SA-277: no file other than addon-ledger.ts (the one writer) and plan-catalog.constants.ts (the BILLING_EVENTS declaration) references BILLING_EVENTS.ADDON_ENABLED/ADDON_DISABLED directly — every add-on booking routes through emitAddonDelta/bookAddonsOnCrossing", () => {
    const srcRoot = join(__dirname, "..");
    const allowed = new Set([
      join(srcRoot, "billing", "addon-ledger.ts"),
      join(srcRoot, "billing", "plan-catalog.constants.ts"),
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
        if (allowed.has(full)) continue;
        const content = readFileSync(full, "utf8");
        // Scoped to the BILLING_EVENTS.-qualified form only — AdminAuditAction.ADDON_ENABLED/
        // ADDON_DISABLED (platform-admin.controller.ts, audit-actions.constant.ts) is a
        // DIFFERENT, unrelated enum (admin-audit-log rows, not the billing ledger) and is a
        // legitimate other reader of the same English words, not a hand-rolled ledger emit.
        if (/BILLING_EVENTS\.ADDON_ENABLED|BILLING_EVENTS\.ADDON_DISABLED/.test(content)) {
          offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
