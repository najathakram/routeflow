import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/** A same-cycle ACTIVE period straddling "now" (mid-cycle, so proration is partial and > 0). */
function activePeriod() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  return {
    periodStart: new Date(now - 15 * DAY),
    periodEnd: new Date(now + 15 * DAY),
  };
}

function catalog() {
  return {
    id: "v7",
    definitions: [
      { planKey: "STARTER", name: "Starter", monthlyPrice: 59, isCustom: false, seatsIncluded: 3 },
      { planKey: "TEAM", name: "Team", monthlyPrice: 149, isCustom: false, seatsIncluded: 10 },
      {
        planKey: "BUSINESS",
        name: "Business",
        monthlyPrice: 349,
        isCustom: false,
        seatsIncluded: 15,
      },
      {
        planKey: "ENTERPRISE",
        name: "Enterprise",
        monthlyPrice: null,
        isCustom: true,
        seatsIncluded: null,
      },
    ],
    addonSkus: [
      { sku: "SEAT_EXTRA", name: "Extra seat", monthlyPrice: 12 },
      { sku: "BUYER_PORTAL", name: "Buyer portal", monthlyPrice: 49 },
      { sku: "REGULATED_ITEMS", name: "Regulated", monthlyPrice: 39 },
      // Self-service SKUs (SELF_SERVICE_ADDON_SKUS) — the only two enableAddon may grant.
      { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
      { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25 },
      // Admin-only SKUs — enableAddon must 403 a self-service request for these.
      { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
      { sku: "SALES_AGENTS", name: "Sales agents", monthlyPrice: 30 },
    ],
  };
}

/**
 * Post-rename catalog (v8) — GROWTH/SCALE have NO matching Prisma TenantPlan enum member.
 *
 * RANK BASIS (the oracle the legacy-rename cases are judged against): rank is `planRank()` —
 * the `PLAN_KEYS` index of the key after `normalizePlanKey()` resolves `LEGACY_PLAN_KEY_ALIASES`
 * (TEAM → GROWTH, BUSINESS → SCALE). It is ORDER-based and price-INDEPENDENT: no catalog price
 * is read to decide UPGRADE vs DOWNGRADE. The renamed-away keys are RETAINED here only so
 * `planMonthly()` can still PRICE a tenant pinned to `TEAM`/`BUSINESS` — never to rank one:
 *   TEAM → GROWTH (rank 1) vs SCALE (rank 2) = strictly higher → UPGRADE
 *   BUSINESS → SCALE (rank 2) vs SCALE (rank 2) = equal, keys differ → SUBSCRIBE (never NOOP)
 * The prices below happen to AGREE with that order, so they cannot tell the two oracles apart;
 * the "PIN: rank is planRank, not catalog price" case below inverts them so they can.
 */
function catalogV8() {
  return {
    id: "v8",
    definitions: [
      { planKey: "STARTER", name: "Starter", monthlyPrice: 99, isCustom: false, seatsIncluded: 3 },
      { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, isCustom: false, seatsIncluded: 10 },
      { planKey: "SCALE", name: "Scale", monthlyPrice: 499, isCustom: false, seatsIncluded: 25 },
      {
        planKey: "ENTERPRISE",
        name: "Enterprise",
        monthlyPrice: null,
        isCustom: true,
        seatsIncluded: null,
      },
      // Retained legacy keys (renamed to GROWTH / SCALE respectively).
      {
        planKey: "TEAM",
        name: "Team (legacy)",
        monthlyPrice: 249,
        isCustom: false,
        seatsIncluded: 10,
      },
      {
        planKey: "BUSINESS",
        name: "Business (legacy)",
        monthlyPrice: 499,
        isCustom: false,
        seatsIncluded: 25,
      },
    ],
    addonSkus: [],
  };
}

/**
 * A copy of the v7 catalog with ONE plan's `seatsIncluded` overridden — used to make the
 * tenant's PINNED version disagree with the PUBLISHED one, which is the only way to tell
 * apart "the warning read the published catalog" from "the warning read the cron's source".
 */
function catalogWithSeats(
  id: string,
  planKey: string,
  seatsIncluded: number,
): ReturnType<typeof catalog> {
  const v = catalog();
  return {
    ...v,
    id,
    definitions: v.definitions.map((d) => (d.planKey === planKey ? { ...d, seatsIncluded } : d)),
  } as ReturnType<typeof catalog>;
}

interface Opts {
  catalog?: ReturnType<typeof catalog>;
  tenantStatus?: string;
  /** The legacy `Tenant.plan` enum — the ONLY place a pre-plans-as-data tenant's plan lives. */
  tenantPlan?: string | null;
  sub?: any;
  priorAddons?: any[];
  existingAddon?: any;
  addonRow?: any;
  /** ACTIVE TENANT_ADMIN/OPERATOR/DRIVER count, as the DOWNGRADE seat warning reads it. */
  activeTeam?: number;
  /**
   * The tenant's PINNED catalog version (`getVersionForTenant`) — what billing-cron
   * `applyScheduledDowngrades` prices and caps a scheduled downgrade from (grandfathering).
   * Defaults to the published one; set it to a DIFFERENT version to tell the two apart.
   */
  pinnedCatalog?: ReturnType<typeof catalog>;
}

function make(opts: Opts = {}) {
  const tx = {
    tenantSubscription: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      // TRIAL-1: cancel()'s TRIAL branch is a compare-and-swap (updateMany) with a
      // re-read (findUnique) only when the CAS is lost — default to a clean win/no-race.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    tenantAddon: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: opts.tenantStatus ?? "TRIAL", plan: opts.tenantPlan ?? null }),
      // TRIAL-1: cancel() on a subscription-less trial/read-only tenant reads + writes the
      // tenant row directly (there is no TenantSubscription row to update).
      update: jest.fn().mockResolvedValue({}),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.sub ?? null),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(opts.priorAddons ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.addonRow ?? null),
    },
    user: { count: jest.fn().mockResolvedValue(opts.activeTeam ?? 0) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const cat = {
    getPublishedCatalog: jest.fn().mockResolvedValue(opts.catalog ?? catalog()),
    getVersionForTenant: jest
      .fn()
      .mockResolvedValue(opts.pinnedCatalog ?? opts.catalog ?? catalog()),
  } as any;
  const proration = {
    quote: jest.fn().mockResolvedValue({ subtotalMonthly: 173, lines: [] }),
    prorationPreview: jest.fn().mockResolvedValue({ proratedToday: 6.4 }),
  } as any;
  const subscription = { getSubscription: jest.fn().mockResolvedValue({ planKey: "TEAM" }) } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const tenantStatus = { invalidate: jest.fn() } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    cat,
    proration,
    subscription,
    entitlements,
    events,
    tenantStatus,
  );
  return { svc, prisma, tx, events, entitlements, tenantStatus, cat };
}

const deltaOf = (events: any, type: string) => {
  const c = events.emit.mock.calls.find((x: any[]) => x[1] === type);
  return c ? c[3]?.amountDelta : undefined;
};
const emitted = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);

describe("SubscriptionMutationService.subscribe (MRR = signed change)", () => {
  it("fresh trial: PLAN_CHANGED delta = plan monthly, add-on delta separate; sum = subtotal (no double-count)", async () => {
    const { svc, tx, events, entitlements } = make({ tenantStatus: "TRIAL" });
    await svc.subscribe(
      "t1",
      { planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }] },
      "admin",
    );
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(149); // plan only, NOT 173
    expect(deltaOf(events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24); // 12 × 2
    // ledger sum = 149 + 24 = 173 = subtotal, counted once
    expect(emitted(events)).toEqual(
      expect.arrayContaining([
        BILLING_EVENTS.TRIAL_CONVERTED,
        BILLING_EVENTS.PLAN_CHANGED,
        BILLING_EVENTS.ADDON_ENABLED,
      ]),
    );
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "ACTIVE",
      plan: "TEAM",
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("PIN T10: ACTIVE cycle switch to a LOWER plan (ANNUAL→MONTHLY) still nets a NEGATIVE plan delta and disables dropped add-ons — the B58 guard must NOT fire on a cycle switch", async () => {
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "ANNUAL" },
      priorAddons: [
        {
          id: "a1",
          addonKey: "CUSTOMER_PACK_100",
          sku: "CUSTOMER_PACK_100",
          quantity: 1,
          active: true,
        },
      ],
    });
    await svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }, "admin");
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(-290); // 59 − 349
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-12); // dropped CUSTOMER_PACK_100
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { active: false },
    });
    expect(emitted(events)).not.toContain(BILLING_EVENTS.TRIAL_CONVERTED);
  });

  it("reactivation from READ_ONLY (stale planKey retained) emits a full +base delta, not 0", async () => {
    const { svc, events } = make({
      tenantStatus: "READ_ONLY",
      sub: { planKey: "BUSINESS" }, // planKey survives the cancellation → READ_ONLY
    });
    await svc.subscribe("t1", { planKey: "BUSINESS", cycle: "MONTHLY" }, "admin");
    // Was NOT paying (READ_ONLY) → prior run-rate is 0, so re-entry is the full +349,
    // mirroring the −349 emitted at churn — NOT 349 − 349 = 0.
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(349);
  });

  it("reactivation re-adds add-ons (churn deactivated them) so the ledger nets symmetrically", async () => {
    const { svc, events } = make({
      tenantStatus: "READ_ONLY",
      sub: { planKey: "BUSINESS" },
      priorAddons: [], // churn (applyScheduledCancellations) deactivated the rows
    });
    await svc.subscribe(
      "t1",
      {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        addons: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
      },
      "admin",
    );
    // Full run-rate re-added: +349 base and +24 add-on (12×2) — matching the −373 at churn.
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(349);
    expect(deltaOf(events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24);
  });

  it("rejects the custom Enterprise plan", async () => {
    await expect(
      make().svc.subscribe("t1", { planKey: "ENTERPRISE", cycle: "MONTHLY" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("writes the legacy TenantPlan enum for renamed keys (GROWTH → TEAM), never the raw key", async () => {
    const { svc, tx } = make({ catalog: catalogV8() });
    await svc.subscribe("t1", { planKey: "GROWTH", cycle: "MONTHLY" });
    // The Prisma TenantPlan enum has no GROWTH/SCALE member — writing the catalog key
    // straight into the shadow column fails enum validation at runtime (500).
    expect(tx.tenantSubscription.upsert.mock.calls[0][0].create).toMatchObject({
      planKey: "GROWTH",
      currentPlan: "TEAM",
    });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ plan: "TEAM" });
  });
});

describe("SubscriptionMutationService.upgrade", () => {
  it("applies instantly (optimistic guard) with MRR delta = new − old", async () => {
    const { svc, tx, events } = make({
      sub: { planKey: "STARTER", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await svc.upgrade("t1", "BUSINESS", "admin");
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].where).toMatchObject({
      planKey: "STARTER",
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(290); // 349 − 59
  });

  it("rejects a concurrent double-upgrade (updateMany matched 0 rows)", async () => {
    const { svc, tx } = make({ sub: { planKey: "STARTER", cycle: "MONTHLY" } });
    tx.tenantSubscription.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.upgrade("t1", "BUSINESS")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a same/lower target", async () => {
    const { svc } = make({ sub: { planKey: "BUSINESS", cycle: "MONTHLY" } });
    await expect(svc.upgrade("t1", "STARTER")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("writes the legacy TenantPlan enum for renamed keys (SCALE → BUSINESS)", async () => {
    const { svc, tx } = make({
      catalog: catalogV8(),
      sub: { planKey: "GROWTH", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await svc.upgrade("t1", "SCALE");
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].data).toMatchObject({
      planKey: "SCALE",
      currentPlan: "BUSINESS",
    });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ plan: "BUSINESS" });
  });
});

describe("SubscriptionMutationService — plan-less rows are not subscriptions (REG-B58)", () => {
  it("REG-B58 upgrade() still refuses a planKey-NULL row on a TRIAL tenant — subscribe() owns trial conversion", async () => {
    const { svc, tx, events } = make({
      catalog: catalogV8(),
      tenantStatus: "TRIAL",
      tenantPlan: "STARTER",
      // The stub shape shipped code mints on a tenant that never subscribed (Stripe-customer
      // creation / the customer-cap grace window): no planKey, no period.
      sub: { planKey: null, cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toThrow(/subscribe first/);
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(BadRequestException);
    // Nothing stamped, nothing booked: no plan, no trialConvertedAt, no PLAN_CHANGED.
    expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("REG-B58 downgrade() refuses the same planKey-NULL TRIAL row", async () => {
    const { svc, tx } = make({
      catalog: catalogV8(),
      tenantStatus: "TRIAL",
      // BUSINESS → SCALE (rank 2), so STARTER (rank 0) IS a real downgrade: the refusal has to
      // come from the plan-less-row precondition, not from the rank check.
      tenantPlan: "BUSINESS",
      sub: { planKey: null, cycle: "MONTHLY", periodStart: null, periodEnd: new Date() },
    });
    await expect(svc.downgrade("t1", "STARTER", [], "admin")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("REG-B58 upgrade() allows a planKey-NULL row on an ACTIVE tenant (manual activation) and books the FULL base", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      catalog: catalogV8(),
      tenantStatus: "ACTIVE",
      // platform-admin activateManualSubscription: tenant.plan set, subscription planKey NULL.
      tenantPlan: "TEAM",
      sub: { planKey: null, cycle: "MONTHLY", periodStart, periodEnd },
    });
    const res: any = await svc.upgrade("t1", "SCALE", "admin");
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].where).toMatchObject({
      planKey: null,
    });
    // A planKey-NULL row contributes 0 to MrrService's snapshot (`planKey: { not: null }`),
    // so gaining a planKey books the FULL 499 — netting to 250 would strand the ledger.
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(499);
    // The CHARGE still nets against the entitlement the tenant already holds (499 − 249).
    expect(res.proratedNow).toBeGreaterThan(0);
    expect(res.proratedNow).toBeLessThan(250);
  });

  it("REG-B58 subscribe() on a planKey-NULL ACTIVE row books the FULL base, not a self-netted 0", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, events } = make({
      tenantStatus: "ACTIVE",
      tenantPlan: "BUSINESS",
      sub: { planKey: null, cycle: "MONTHLY", periodStart, periodEnd },
    });
    await svc.subscribe("t1", { planKey: "BUSINESS", cycle: "MONTHLY" }, "admin");
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(349);
  });

  it("REG-B58 subscribe() on an ACTIVE row that DOES carry a planKey is refused for its own plan (round 3, finding 5)", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    // Re-subscribing to the plan you already hold books a 0 delta and buys nothing — while
    // resetting periodStart/periodEnd (the B58 harm). The netting arithmetic it used to pin
    // (ACTIVE + a stored planKey nets against the old plan) stays covered by PIN T10's
    // ACTIVE cycle switch, which is the remaining route through this branch.
    await expect(
      svc.subscribe("t1", { planKey: "BUSINESS", cycle: "MONTHLY" }, "admin"),
    ).rejects.toThrow(/already on this plan/);
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("SubscriptionMutationService downgrade / add-ons", () => {
  it("downgrade schedules without changing entitlements now", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx, events, entitlements } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd },
    });
    await svc.downgrade("t1", "STARTER", ["u1"], "admin");
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      downgradeToPlanKey: "STARTER",
      downgradeEffectiveAt: periodEnd,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED);
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("enableAddon charges the qty delta only (idempotent re-enable at same qty emits nothing)", async () => {
    // CUSTOMER_PACK_100, not SEAT_EXTRA — SEAT_EXTRA is seat-billing plumbing, never a
    // self-service toggle (see the SELF_SERVICE_ADDON_SKUS tests below).
    const first = make();
    await first.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "admin");
    expect(deltaOf(first.events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24); // 12 × 2

    const again = make({ existingAddon: { active: true, quantity: 2 } });
    await again.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2);
    expect(emitted(again.events)).not.toContain(BILLING_EVENTS.ADDON_ENABLED); // no change → no MRR event
  });

  it("disableAddon credits the add-on's price (CUSTOMER_PACK_100 × 2)", async () => {
    const { svc, events, tx } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        quantity: 2,
        active: true,
      },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100");
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-24); // 12 × 2
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { active: false },
    });
  });
});

describe("SubscriptionMutationService.enableAddon self-service gate (SELF_SERVICE_ADDON_SKUS)", () => {
  it("403s a self-service enable of an admin-only SKU (MSRP)", async () => {
    const { svc, tx, entitlements } = make();
    await expect(svc.enableAddon("t1", "MSRP", 1, "admin")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("403s a self-service enable of an admin-only SKU (SALES_AGENTS)", async () => {
    const { svc } = make();
    await expect(svc.enableAddon("t1", "SALES_AGENTS", 1, "admin")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows self-service enable of CUSTOMER_PACK_100", async () => {
    const { svc, tx, entitlements } = make();
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "admin");
    expect(tx.tenantAddon.upsert).toHaveBeenCalled();
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("403s a self-service disable of an admin-only SKU, incl. via the legacy addonKey", async () => {
    const { svc, tx } = make({
      addonRow: { id: "a1", addonKey: "tobacco_dealer", sku: null, quantity: 1, active: true },
    });
    // tobacco_dealer bridges to REGULATED_ITEMS — admin-granted, so the tenant cannot
    // switch it off (re-enabling it is a 403, which would be a support-only dead end).
    await expect(svc.disableAddon("t1", "tobacco_dealer")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.tenantAddon.update).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService.subscribe self-service gate (SELF_SERVICE_ADDON_SKUS)", () => {
  it("403s a subscribe that names an admin-only SKU in addons[] — the enableAddon back door", async () => {
    const { svc, tx, entitlements } = make();
    await expect(
      svc.subscribe(
        "t1",
        { planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "MSRP" }, { sku: "SALES_AGENTS" }] },
        "admin",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("never revokes an admin-granted add-on the payload omits", async () => {
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM" },
      priorAddons: [{ id: "a1", addonKey: "msrp", sku: null, quantity: 1, active: true }],
    });
    await svc.subscribe("t1", { planKey: "TEAM", cycle: "MONTHLY" }, "admin");
    expect(tx.tenantAddon.update).not.toHaveBeenCalled(); // MSRP stays active
    expect(emitted(events)).not.toContain(BILLING_EVENTS.ADDON_DISABLED);
  });
});

describe("SubscriptionMutationService.subscribe ACTIVE plan-change guard (REG-B58 T1)", () => {
  it("REG-B58 T1 refuses an ACTIVE same-cycle plan change", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const attempt = svc.subscribe("t1", { planKey: "BUSINESS", cycle: "MONTHLY" });
    // Message oracle first — the class alone is shared with several other guards in this
    // service, so it would not distinguish THIS refusal from an unrelated 409.
    await expect(attempt).rejects.toThrow(/use upgrade or downgrade/);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

// PIN T13 REWRITTEN (round-3 ruling on finding 5, superseding Amendment 2): a legacy alias
// tenant re-picking its OWN renamed plan is not a re-pin opportunity, it is a no-op — and
// letting it through subscribe() paid for the pin with a periodStart/periodEnd reset, the exact
// B58 harm. The old pin asserted the upsert ran; it never asserted the period, so nothing
// caught the reset. No REG token, so `-t "REG-B(58|73|107)"` never collects it (L-060).
describe("SubscriptionMutationService.subscribe — legacy alias re-pick pins", () => {
  it("PIN T13: a legacy same-rank re-pick (BUSINESS→SCALE) is REFUSED, so the period is never reset", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      catalog: catalogV8(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const attempt = svc.subscribe("t1", { planKey: "SCALE", cycle: "MONTHLY" });
    // Message oracle: the class alone would not tell this refusal apart from the
    // different-rank one, which carries a different instruction ("use upgrade or downgrade").
    await expect(attempt).rejects.toThrow(/already on this plan/);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    // The harm the old pin missed: the upsert's update branch writes periodStart/periodEnd.
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("PIN T13b: the same alias re-pick previews NOOP — the chooser never routes it to subscribe()", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: catalogV8(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(preview.action).toBe("NOOP");
    // The chooser marks the current card from the NORMALIZED key — "BUSINESS" matches no
    // listed catalog key, which is why the alias tenant saw SCALE as a plain, pickable plan.
    expect(preview.fromPlanKey).toBe("SCALE");
  });
});

describe("SubscriptionMutationService.planChangePreview (REG-B58 T2)", () => {
  it("REG-B58 T2 ACTIVE same-cycle UPGRADE: proratedNow = half the monthly delta, keepsRenewalAt = periodEnd", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    // Existence is its own oracle: without it a missing method reports as an identical
    // `Received: undefined` in every T2 case, proving the wiring instead of the defect.
    expect(typeof (svc as any).planChangePreview).toBe("function");
    const preview: any = await (svc as any).planChangePreview("t1", "BUSINESS", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("UPGRADE");
    // VALUE ORACLE (this is the figure choose-plan renders as "Due today", so it is pinned to
    // the cent, not just to > 0): the charge is the remaining fraction of the MONTHLY DELTA.
    // Fixture = TEAM 149 -> BUSINESS 349 (delta 200) over an exact 30-day period with 15 days
    // left => 200 x 0.5 = 100.00. The un-prorated delta (200), the full new price (349) and the
    // prorated new price (174.50) are all wrong and all used to pass here.
    expect(preview.proratedNow).toBeCloseTo(100, 1);
    expect(preview.proratedNow).toBeLessThan(200);
    expect(preview?.keepsRenewalAt).toEqual(periodEnd);
  });

  it("REG-B58 T2 ACTIVE same-cycle DOWNGRADE: effectiveAt = periodEnd, proratedNow null", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await (svc as any).planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("DOWNGRADE");
    expect(preview?.effectiveAt).toEqual(periodEnd);
    expect(preview?.proratedNow).toBeNull();
  });

  it("REG-B58 T2 DOWNGRADE over the target seat cap warns with the counts", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
      activeTeam: 8, // > STARTER's seatsIncluded (3) -> the cron would deactivate the staff
    });
    const preview: any = await (svc as any).planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("DOWNGRADE");
    // The tenant has to see BOTH numbers before this is committable (the web half gates the
    // commit button on this warning): "8 active users" vs. the plan's "3 seats".
    expect(preview?.warning).toMatch(/8 active users/);
    expect(preview?.warning).toMatch(/3 seats/);
  });

  it("REG-B58 T2 DOWNGRADE within the target seat cap carries no warning", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
      activeTeam: 2, // <= STARTER's seatsIncluded (3) -> no seat sweep, so no warning
    });
    const preview: any = await (svc as any).planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("DOWNGRADE");
    expect(preview?.warning).toBeUndefined();
  });

  it("REG-B58 T2 DOWNGRADE seat warning reads the tenant's PINNED version, not the published one", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, cat } = make({
      tenantStatus: "ACTIVE",
      // Published raised STARTER to 25 seats; this tenant is still pinned to the version that
      // caps it at 3 — and billing-cron applyScheduledDowngrades sweeps against the PINNED cap.
      catalog: catalogWithSeats("v-published", "STARTER", 25),
      pinnedCatalog: catalogWithSeats("v-pinned", "STARTER", 3),
      sub: {
        planKey: "BUSINESS",
        planVersionId: "v-pinned",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      },
      activeTeam: 8,
    });
    const preview: any = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    // Published (25) would have said "no warning"; the sweep the tenant will actually get is
    // priced off the pinned cap (3), so the warning must fire and quote THAT number.
    expect(preview.warning).toMatch(/8 active users/);
    expect(preview.warning).toMatch(/3 seats/);
    expect(cat.getVersionForTenant).toHaveBeenCalledWith("v-pinned");
  });

  it("REG-B58 T2 DOWNGRADE within the PINNED seat cap carries no warning even when the published cap is lower", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, cat } = make({
      tenantStatus: "ACTIVE",
      catalog: catalogWithSeats("v-published", "STARTER", 3),
      pinnedCatalog: catalogWithSeats("v-pinned", "STARTER", 25),
      sub: {
        planKey: "BUSINESS",
        planVersionId: "v-pinned",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      },
      activeTeam: 8,
    });
    const preview: any = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    // The cron would not sweep (8 <= 25), so warning-and-acknowledge would be a false alarm.
    expect(preview.warning).toBeUndefined();
    expect(cat.getVersionForTenant).toHaveBeenCalledWith("v-pinned");
  });

  it("REG-B58 T2 a TRIAL tenant always previews SUBSCRIBE", async () => {
    const { svc } = make({ tenantStatus: "TRIAL" });
    const preview: any = await (svc as any).planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("SUBSCRIBE");
  });

  it("REG-B58 T2 no prior subscription (planKey null) previews SUBSCRIBE", async () => {
    const { svc } = make({ tenantStatus: "ACTIVE", sub: null });
    const preview: any = await (svc as any).planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("SUBSCRIBE");
  });

  it("REG-B58 T2 ACTIVE cycle switch (same plan) previews SUBSCRIBE with a warning", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await (svc as any).planChangePreview("t1", "TEAM", "ANNUAL");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("SUBSCRIBE");
    expect(preview?.warning).toBeTruthy();
  });

  it("REG-B58 T2 same plan and cycle previews NOOP", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await (svc as any).planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("NOOP");
  });

  it("REG-B58 T2 legacy key rename with a DIFFERENT rank (TEAM→SCALE) previews UPGRADE", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: catalogV8(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await (svc as any).planChangePreview("t1", "SCALE", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("UPGRADE");
  });

  it("PIN: rank is planRank, not catalog price", async () => {
    // Catalog prices deliberately CONTRADICT PLAN_KEYS order (GROWTH 999 > SCALE 499). If rank
    // were the catalog `monthlyPrice`, GROWTH→SCALE would classify as a DOWNGRADE; planRank
    // (order-based) still says UPGRADE. This is the only case that distinguishes the two.
    const inverted = catalogV8();
    inverted.definitions = inverted.definitions.map((d) =>
      d.planKey === "GROWTH" ? { ...d, monthlyPrice: 999 } : d,
    );
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: inverted,
      tenantStatus: "ACTIVE",
      sub: { planKey: "GROWTH", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await (svc as any).planChangePreview("t1", "SCALE", "MONTHLY");
    expect(preview).toBeDefined();
    expect(preview?.action).toBe("UPGRADE");
  });

  // Amendment 2 (equal rank → SUBSCRIBE) is SUPERSEDED by the round-3 ruling on finding 5:
  // routing an alias re-pick to subscribe() reset the period (B58) and wiped a pending
  // downgrade. Equal rank IS the same plan, so it previews NOOP — or KEEP_CURRENT, which is
  // the undo the alias tenant could never reach while the compare used the raw stored key.
  it("REG-B58 T2 an alias tenant (BUSINESS) with a downgrade armed previews KEEP_CURRENT for its own plan (SCALE)", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: catalogV8(),
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: periodEnd,
      },
    });
    const preview = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(preview.action).toBe("KEEP_CURRENT");
    expect(preview.warning).toBeTruthy();
    expect(preview.keepsRenewalAt).toEqual(periodEnd);
  });
});

describe("SubscriptionMutationService.planChangePreview — pending cancellation (round 3, findings 3/12)", () => {
  it("UPGRADE with a cancellation armed warns that committing keeps the subscription alive", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "TEAM",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
      },
    });
    const preview = await svc.planChangePreview("t1", "BUSINESS", "MONTHLY");
    expect(preview.action).toBe("UPGRADE");
    // upgrade() writes cancelAtPeriodEnd:false — silently revoking a cancellation the tenant
    // made for price reasons, and applyScheduledCancellations then never fires.
    expect(preview.warning).toMatch(/cancellation is pending/i);
  });

  it("UPGRADE with NO cancellation armed carries no warning", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview = await svc.planChangePreview("t1", "BUSINESS", "MONTHLY");
    expect(preview.action).toBe("UPGRADE");
    expect(preview.warning).toBeUndefined();
  });

  it("DOWNGRADE with a cancellation armed warns, and still carries the seat warning alongside it", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
      },
      activeTeam: 8, // > STARTER's 3 seats → the seat warning fires too
    });
    const preview = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    expect(preview.warning).toMatch(/cancellation is pending/i);
    // Composed, not traded: losing the seat warning here would drop the "your staff will be
    // deactivated" notice the web half gates the commit button on.
    expect(preview.warning).toMatch(/8 active users/);
  });

  it("DOWNGRADE with NO cancellation armed and within the seat cap carries no warning", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
      activeTeam: 2,
    });
    const preview = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    expect(preview.warning).toBeUndefined();
  });
});

describe("SubscriptionMutationService — custom (Enterprise) plans are never self-service (round 3, findings 4/6/11)", () => {
  it("a custom TARGET previews CONTACT_SALES, never UPGRADE with a negative proratedNow", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview = await svc.planChangePreview("t1", "ENTERPRISE", "MONTHLY");
    // ENTERPRISE ranks 3 (> BUSINESS) with a NULL catalog price, so ranking it answered
    // UPGRADE with proratedNow ≈ −174.50 — a negative "Due today" the commit path then 400s.
    expect(preview.action).toBe("CONTACT_SALES");
    expect(preview.proratedNow).toBeNull();
    expect(preview.effectiveAt).toBeNull();
    expect(preview.warning).toMatch(/contact sales/i);
  });

  it("a custom SOURCE picking a different plan previews CONTACT_SALES, never DOWNGRADE", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "ENTERPRISE", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview = await svc.planChangePreview("t1", "BUSINESS", "MONTHLY");
    // DOWNGRADE promised "$0 due today" and the cron then booked a POSITIVE delta (the custom
    // side prices 0 from the catalog) and overwrote the negotiated basePriceSnapshot.
    expect(preview.action).toBe("CONTACT_SALES");
    expect(preview.effectiveAt).toBeNull();
  });

  it("a custom source re-picking its OWN plan still reaches NOOP (the screen never eats the undo)", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "ENTERPRISE", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview = await svc.planChangePreview("t1", "ENTERPRISE", "MONTHLY");
    expect(preview.action).toBe("NOOP");
  });

  it("downgrade() refuses a custom SOURCE with the same message upgrade() uses", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "ENTERPRISE", cycle: "MONTHLY", periodStart, periodEnd },
    });
    const attempt = svc.downgrade("t1", "STARTER", [], "admin");
    await expect(attempt).rejects.toThrow(/custom plan — contact sales/);
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService — an unrankable plan key is refused at the seam (round 3, finding 13)", () => {
  /** The published catalog is DATA: nothing constrains a definition's planKey to PLAN_KEYS. */
  function catalogWithOffListKey() {
    const v = catalog();
    (v.definitions as any[]).push({
      planKey: "PRO",
      name: "Pro",
      monthlyPrice: 199,
      isCustom: false,
      seatsIncluded: 5,
    });
    return v;
  }

  it("planChangePreview throws instead of ranking an off-list key as −1 (a DOWNGRADE from everything)", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: catalogWithOffListKey(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "STARTER", cycle: "MONTHLY", periodStart, periodEnd },
    });
    // planRank("PRO") = −1 < rank(STARTER) = 0, so the preview answered DOWNGRADE — from the
    // CHEAPEST plan — and the cron would then write basePriceSnapshot: null (a free tenant).
    await expect(svc.planChangePreview("t1", "PRO", "MONTHLY")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("downgrade() refuses an off-list key that IS in the published catalog", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx } = make({
      catalog: catalogWithOffListKey(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
    });
    // The definition exists, so the "Unknown plan" catalog check passes; only the rank check
    // catches it — `-1 >= planRank(BUSINESS)` is false, so the schedule used to be written.
    await expect(svc.downgrade("t1", "PRO", [], "admin")).rejects.toThrow(/Unknown plan/);
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService — one armed transition at a time (REG-B58 T10)", () => {
  it("REG-B58 T10 upgrade() disarms a pending downgrade and cancellation in the same transaction", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "STARTER",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: periodEnd,
      },
    });
    await svc.upgrade("t1", "BUSINESS", "admin");
    // Left armed, billing-cron applyScheduledDowngrades (which filters on
    // downgradeEffectiveAt alone) drops the tenant back off the plan they just paid for.
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].data).toMatchObject({
      planKey: "BUSINESS",
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(290); // 349 − 59, unchanged
  });

  it("REG-B58 T10 downgrade() replaces a pending cancellation rather than stacking on it", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd, cancelAtPeriodEnd: true },
    });
    await svc.downgrade("t1", "STARTER", [], "admin");
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      downgradeToPlanKey: "STARTER",
      downgradeEffectiveAt: periodEnd,
      cancelAtPeriodEnd: false,
    });
  });

  it("REG-B58 T10 cancel() supersedes a scheduled downgrade instead of stacking on it", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: periodEnd,
        retainedUserIds: ["u1"],
      },
    });
    await svc.cancel("t1", "admin");
    // Both armed, applyScheduledDowngrades would re-price basePriceSnapshot onto STARTER
    // before applyScheduledCancellations books the churn delta from it — so the negative MRR
    // delta would depend on which daily/hourly cron happened to run first.
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      cancelAtPeriodEnd: true,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
      retainedUserIds: [],
    });
  });

  it("REG-B58 T10 resume() clears a scheduled downgrade too, without touching the plan or period", async () => {
    const { svc, tx } = make({
      sub: {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: new Date("2026-08-01"),
      },
    });
    await svc.resume("t1", "admin");
    const data = tx.tenantSubscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
    });
    expect(data).not.toHaveProperty("planKey");
    expect(data).not.toHaveProperty("periodStart");
    expect(data).not.toHaveProperty("periodEnd");
  });
});

describe("SubscriptionMutationService.cancel — trial/read-only tenants with no subscription row (TRIAL-1)", () => {
  // (1) TRIAL, no row. RED against 51daea36: that build writes via `tx.tenant.update`
  // unconditionally (no CAS `updateMany` call exists at all), so asserting an `updateMany`
  // call with a `{ id, status: "TRIAL" }` where-clause fails outright.
  it("TRIAL-1 (1) TRIAL no row: CAS updateMany on Tenant.status, emits TRIAL_CANCELLED without amountDelta, invalidates both caches once, resolves trial", async () => {
    const { svc, tx, events, entitlements, tenantStatus } = make({
      sub: null,
      tenantStatus: "TRIAL",
    });
    await expect(svc.cancel("t-1", "u-1")).resolves.toEqual({ cancelled: "trial" });
    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t-1", status: "TRIAL" },
      data: {
        status: "READ_ONLY",
        readOnlyReason: "trial_cancelled",
        trialEndsAt: expect.any(Date),
      },
    });
    const call = events.emit.mock.calls.find((c: any[]) => c[1] === BILLING_EVENTS.TRIAL_CANCELLED);
    expect(call).toBeDefined();
    expect(call![3]).not.toHaveProperty("amountDelta");
    expect(entitlements.invalidate).toHaveBeenCalledTimes(1);
    expect(tenantStatus.invalidate).toHaveBeenCalledTimes(1);
  });

  // (2) TRIAL, WITH a row. RED against 51daea36: the old TRIAL branch calls
  // `tx.tenantSubscription.update` whenever `sub` is present — this "NOT called" assertion
  // fails against it.
  it("TRIAL-1 (2) TRIAL with a row: same CAS + emit as (1), and the TenantSubscription row is left untouched", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx, events } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd },
      tenantStatus: "TRIAL",
    });
    await expect(svc.cancel("t-1", "u-1")).resolves.toEqual({ cancelled: "trial" });
    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t-1", status: "TRIAL" },
      data: expect.objectContaining({ status: "READ_ONLY", readOnlyReason: "trial_cancelled" }),
    });
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).toContain(BILLING_EVENTS.TRIAL_CANCELLED);
  });

  // (3) READ_ONLY, no row. RED against 51daea36 only in spirit (that build already resolves
  // "already_read_only" here) — kept as the guard for the NEW short-circuit ordering.
  it("TRIAL-1 (3) READ_ONLY no row: idempotent success, no writes, no emits", async () => {
    const { svc, tx, events } = make({ sub: null, tenantStatus: "READ_ONLY" });
    await expect(svc.cancel("t-1", "u-1")).resolves.toEqual({ cancelled: "already_read_only" });
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.tenant.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // (4) READ_ONLY, WITH a row. RED against 51daea36: READ_ONLY is only checked inside the
  // `!sub` branch there, so a READ_ONLY tenant WITH a row falls through to the legacy
  // schedule path and DOES call `tenantSubscription.update` + emit SUBSCRIPTION_CANCELED —
  // this assertion fails against it (F6 in the digest).
  it("TRIAL-1 (4) READ_ONLY with a row: idempotent success, row untouched, no SUBSCRIPTION_CANCELED emit", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx, events } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd },
      tenantStatus: "READ_ONLY",
    });
    await expect(svc.cancel("t-1", "u-1")).resolves.toEqual({ cancelled: "already_read_only" });
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
  });

  // (5) ACTIVE, no row — regression guard, GREEN today and after.
  it("TRIAL-1 (5) ACTIVE no row: genuine anomaly, still 404s", async () => {
    const { svc } = make({ sub: null, tenantStatus: "ACTIVE" });
    await expect(svc.cancel("t-1", "u-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  // (6) ACTIVE, WITH a row — regression guard for the legacy path, GREEN today and after.
  // `make()` defaults `tenantStatus` to "TRIAL" (F5 in the digest) — this case must pass it
  // explicitly, or it silently exercises the NEW TRIAL branch instead of the legacy one.
  it("TRIAL-1 (6) ACTIVE with a row: legacy schedule path, untouched by the TRIAL/READ_ONLY branches", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx, events } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd },
      tenantStatus: "ACTIVE",
    });
    await svc.cancel("t-1", "u-1");
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      cancelAtPeriodEnd: true,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
    expect(tx.tenant.updateMany).not.toHaveBeenCalled();
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  // (7)/(8) exercise the CAS-lost re-read — unreachable in 51daea36 (no CAS exists there).
  it("TRIAL-1 (7) CAS lost, re-read READ_ONLY: a concurrent cancel already won — idempotent success, no emit", async () => {
    const { svc, tx, events } = make({ sub: null, tenantStatus: "TRIAL" });
    tx.tenant.updateMany.mockResolvedValue({ count: 0 });
    tx.tenant.findUnique.mockResolvedValue({ status: "READ_ONLY" });
    await expect(svc.cancel("t-1", "u-1")).resolves.toEqual({ cancelled: "already_read_only" });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("TRIAL-1 (8) CAS lost, re-read ACTIVE: a concurrent subscribe/webhook won — refuses instead of overwriting a paying tenant", async () => {
    const { svc, tx, events, entitlements, tenantStatus } = make({
      sub: null,
      tenantStatus: "TRIAL",
    });
    tx.tenant.updateMany.mockResolvedValue({ count: 0 });
    tx.tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });
    await expect(svc.cancel("t-1", "u-1")).rejects.toBeInstanceOf(ConflictException);
    expect(events.emit).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
    expect(tenantStatus.invalidate).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService — legacy rows and null periods (REG-B58 T1/T2)", () => {
  it("REG-B58 T1 refuses an ACTIVE same-cycle plan change on a legacy row (planKey NULL, plan enum only)", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { periodStart, periodEnd } = activePeriod();
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      tenantPlan: "BUSINESS", // → SCALE; the subscription itself predates plans-as-data
      sub: { planKey: null, cycle: "MONTHLY", periodStart, periodEnd },
    });
    await expect(
      svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // A handled 4xx is invisible otherwise (Sentry captures >= 500 only, no access log).
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("REG-B58 T2 a legacy row (planKey NULL, plan enum BUSINESS) previews DOWNGRADE, not SUBSCRIBE", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      tenantPlan: "BUSINESS",
      sub: { planKey: null, cycle: "MONTHLY", periodStart, periodEnd },
    });
    const preview: any = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    expect(preview.effectiveAt).toEqual(periodEnd);
  });

  it("REG-B58 T2 an ACTIVE subscription with NO periodEnd previews SUBSCRIBE (the cron could never apply a downgrade)", async () => {
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    const preview: any = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("SUBSCRIBE");
  });

  it("REG-B58 T1 a subscription with NO periodEnd is NOT refused — subscribe() is what heals it", async () => {
    const { svc, tx } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await expect(
      svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }),
    ).resolves.toBeDefined();
    expect(tx.tenantSubscription.upsert).toHaveBeenCalled();
  });

  it("REG-B58 T10 downgrade() refuses a subscription with no periodEnd instead of writing an unappliable schedule", async () => {
    const { svc, tx } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd: null },
    });
    await expect(svc.downgrade("t1", "STARTER", [], "admin")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService.planChangePreview — KEEP_CURRENT undo (REG-B58 T2)", () => {
  it("REG-B58 T2 same plan + cycle with a downgrade armed previews KEEP_CURRENT, not a dead NOOP", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "TEAM",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: periodEnd,
      },
    });
    const preview: any = await svc.planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview.action).toBe("KEEP_CURRENT");
    expect(preview.warning).toBeTruthy();
    expect(preview.keepsRenewalAt).toEqual(periodEnd);
  });

  it("REG-B58 T2 same plan + cycle with a cancellation armed previews KEEP_CURRENT", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd, cancelAtPeriodEnd: true },
    });
    const preview: any = await svc.planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview.action).toBe("KEEP_CURRENT");
  });

  it("REG-B58 T2 the SUBSCRIBE / NOOP paths never fetch the published catalog", async () => {
    const { svc, cat } = make({ tenantStatus: "TRIAL" });
    const preview: any = await svc.planChangePreview("t1", "TEAM", "MONTHLY");
    expect(preview.action).toBe("SUBSCRIBE");
    // proration.quote() already runs this uncached query on every /billing/quote — only the
    // UPGRADE branch needs it, so the preview must not run it a second time.
    expect(cat.getPublishedCatalog).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService.planChangePreview — seatAckRequired (round 4, hazard 1)", () => {
  /**
   * The seat consequence is its OWN field because `warning` composes unrelated notices. The
   * chooser gates "I understand these users will be deactivated" on this flag; keying it on
   * `!!warning` made a cancellation-only DOWNGRADE demand consent to a deactivation that
   * billing-cron's `applyScheduledDowngrades` would never perform (it acts only over cap).
   */
  it("PIN: DOWNGRADE with a cancellation armed but UNDER the target cap warns yet keeps seatAckRequired false", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
      },
      activeTeam: 2, // <= STARTER's 3 seats — nothing is deactivated
    });
    const preview = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    // The cancellation notice is still delivered...
    expect(preview.warning).toMatch(/cancellation is pending/i);
    // ...and it must NOT be readable as a seat consequence.
    expect(preview.seatAckRequired).toBe(false);
    expect(preview.warning).not.toMatch(/deactivated/i);
  });

  it("PIN: DOWNGRADE OVER the target cap sets seatAckRequired true", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
      activeTeam: 8, // > STARTER's 3 seats
    });
    const preview = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.action).toBe("DOWNGRADE");
    expect(preview.seatAckRequired).toBe(true);
    expect(preview.warning).toMatch(/8 active users/);
  });

  it("PIN: a DOWNGRADE within the cap with nothing armed is false, never undefined", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd },
      activeTeam: 2,
    });
    const preview = await svc.planChangePreview("t1", "STARTER", "MONTHLY");
    expect(preview.seatAckRequired).toBe(false);
  });

  it("PIN: EVERY non-DOWNGRADE action carries seatAckRequired: false (the web mirror requires it)", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const active = (sub: any) => ({ tenantStatus: "ACTIVE", sub });
    // [expected action, make() opts, planKey, cycle]
    const cases: Array<[string, Opts, string, string]> = [
      ["SUBSCRIBE", { tenantStatus: "TRIAL" }, "TEAM", "MONTHLY"],
      [
        "NOOP",
        active({ planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd }),
        "TEAM",
        "MONTHLY",
      ],
      [
        "KEEP_CURRENT",
        active({
          planKey: "TEAM",
          cycle: "MONTHLY",
          periodStart,
          periodEnd,
          downgradeToPlanKey: "STARTER",
        }),
        "TEAM",
        "MONTHLY",
      ],
      [
        "SUBSCRIBE",
        active({ planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd }),
        "TEAM",
        "ANNUAL",
      ],
      [
        "UPGRADE",
        active({ planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd }),
        "BUSINESS",
        "MONTHLY",
      ],
      [
        "CONTACT_SALES",
        active({ planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd }),
        "ENTERPRISE",
        "MONTHLY",
      ],
    ];
    for (const [action, opts, planKey, cycle] of cases) {
      const { svc } = make(opts);
      const preview = await svc.planChangePreview("t1", planKey, cycle as never);
      expect(preview.action).toBe(action);
      expect(preview.seatAckRequired).toBe(false);
    }
  });
});

describe("SubscriptionMutationService.planChangePreview — a cycle switch says what it disarms (round 4, hazard 2)", () => {
  /**
   * The cycle switch commits through subscribe(), whose upsert `update` branch writes
   * cancelAtPeriodEnd:false / downgradeToPlanKey:null / downgradeEffectiveAt:null — the same
   * silent revocation the UPGRADE and DOWNGRADE branches already warn about.
   */
  const cycleSwitchSub = (extra: Record<string, unknown> = {}) => {
    const { periodStart, periodEnd } = activePeriod();
    return { planKey: "TEAM", cycle: "MONTHLY", periodStart, periodEnd, ...extra };
  };

  it("PIN: a cycle switch with a cancellation armed warns it is revoked, alongside the proration notice", async () => {
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: cycleSwitchSub({ cancelAtPeriodEnd: true }),
    });
    const preview = await svc.planChangePreview("t1", "TEAM", "ANNUAL");
    expect(preview.action).toBe("SUBSCRIBE");
    expect(preview.warning).toMatch(/not prorated/i);
    expect(preview.warning).toMatch(/cancellation is pending/i);
  });

  it("PIN: a cycle switch with a downgrade armed warns that switching cycle cancels it", async () => {
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: cycleSwitchSub({ downgradeToPlanKey: "STARTER" }),
    });
    const preview = await svc.planChangePreview("t1", "TEAM", "ANNUAL");
    expect(preview.action).toBe("SUBSCRIBE");
    expect(preview.warning).toMatch(/not prorated/i);
    expect(preview.warning).toMatch(/scheduled downgrade is pending/i);
  });

  it("PIN: both armed at once compose, never trade", async () => {
    const { svc } = make({
      tenantStatus: "ACTIVE",
      sub: cycleSwitchSub({ cancelAtPeriodEnd: true, downgradeToPlanKey: "STARTER" }),
    });
    const preview = await svc.planChangePreview("t1", "TEAM", "ANNUAL");
    expect(preview.warning).toMatch(/cancellation is pending/i);
    expect(preview.warning).toMatch(/scheduled downgrade is pending/i);
  });

  it("PIN: a cycle switch with nothing armed carries only the proration notice", async () => {
    const { svc } = make({ tenantStatus: "ACTIVE", sub: cycleSwitchSub() });
    const preview = await svc.planChangePreview("t1", "TEAM", "ANNUAL");
    expect(preview.warning).toBe(
      "Switching billing cycle takes effect immediately and is not prorated.",
    );
  });
});

describe("SubscriptionMutationService.planChangePreview — the off-list refusal is scoped to the ranking paths (round 4, hazard 6)", () => {
  /** The published catalog is DATA: nothing constrains a definition's planKey to PLAN_KEYS. */
  function catalogWithOffListKey() {
    const v = catalog();
    (v.definitions as Array<Record<string, unknown>>).push({
      planKey: "PRO",
      name: "Pro",
      monthlyPrice: 199,
      isCustom: false,
      seatsIncluded: 5,
    });
    return v;
  }

  it("PIN: a TRIAL tenant quoting an off-list published key still previews SUBSCRIBE", async () => {
    // The refusal used to sit above the tenant/status branch, so ONE mis-published definition
    // 400'd the entire /billing/quote for every tenant on that card — including the fresh
    // subscribe path, which never ranks and prices the definition correctly from the catalog.
    const { svc } = make({ catalog: catalogWithOffListKey(), tenantStatus: "TRIAL", sub: null });
    const preview = await svc.planChangePreview("t1", "PRO", "MONTHLY");
    expect(preview.action).toBe("SUBSCRIBE");
    expect(preview.seatAckRequired).toBe(false);
  });

  it("PIN: an ACTIVE tenant quoting the same off-list key still gets the 400", async () => {
    const { periodStart, periodEnd } = activePeriod();
    const { svc } = make({
      catalog: catalogWithOffListKey(),
      tenantStatus: "ACTIVE",
      sub: { planKey: "STARTER", cycle: "MONTHLY", periodStart, periodEnd },
    });
    await expect(svc.planChangePreview("t1", "PRO", "MONTHLY")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
