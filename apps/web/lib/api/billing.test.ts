/**
 * REG-B58 (T4u) — `dispatchPlanChange` is the single routing point every
 * plan-change entrance commits through (ruling §2/§9 B58 web). Before F18 the
 * chooser always posted `/billing/subscribe`, so an ACTIVE tenant's plan swap
 * hit the fresh-subscribe endpoint (and, after the API half, its refusal).
 *
 * This is the PRE-DEPLOY oracle for the routing branch: it is a pure function
 * over a quote plus three mutate callbacks, so it needs no DOM and no server.
 * The Playwright project `change-plan-routing`
 * (apps/web/e2e/33-change-plan-routing.spec.ts) covers the complementary half —
 * that the page actually reaches this function with the server's quote — and
 * runs post-deploy.
 */
import { dispatchPlanChange, type Cycle, type PlanChange, type QuoteResult } from "./billing";

function quote(
  change: PlanChange | null,
  planKey = "BUSINESS",
  cycle: Cycle = "MONTHLY",
): QuoteResult {
  return {
    planKey,
    planName: planKey === "BUSINESS" ? "Business" : "Starter",
    cycle,
    isCustom: false,
    lines: [],
    subtotalMonthly: 199,
    dueToday: 0,
    annualSaving: 0,
    renewalAt: "2026-10-06T00:00:00.000Z",
    change,
  };
}

/** `seatAckRequired` is the server's own seat-consequence signal (never inferred from
 *  `warning`); routing does not read it, so it defaults to the harmless false. */
function change(action: PlanChange["action"], seatAckRequired = false): PlanChange {
  return { action, proratedNow: null, effectiveAt: null, keepsRenewalAt: null, seatAckRequired };
}

/** `cycle` is the caller's LIVE toggle — deliberately separate from the quote's echoed
 *  cycle, which the tests below drive apart to pin which one is committed. */
function mutations(cycle: Cycle = "MONTHLY") {
  return {
    cycle,
    upgrade: jest.fn(),
    downgrade: jest.fn(),
    subscribe: jest.fn(),
  };
}

describe("dispatchPlanChange — REG-B58 routing", () => {
  it("routes UPGRADE to the upgrade mutation only", () => {
    const m = mutations();
    dispatchPlanChange(quote(change("UPGRADE")), m);
    expect(m.upgrade).toHaveBeenCalledTimes(1);
    expect(m.upgrade).toHaveBeenCalledWith({ planKey: "BUSINESS" }, undefined);
    expect(m.downgrade).not.toHaveBeenCalled();
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("routes DOWNGRADE to the downgrade mutation with an empty retained-seat list", () => {
    const m = mutations();
    dispatchPlanChange(quote(change("DOWNGRADE"), "STARTER"), m);
    expect(m.downgrade).toHaveBeenCalledTimes(1);
    // `[]` = "keep only admins" server-side; pinned here so a change to the
    // destructive half of the payload cannot land unnoticed.
    expect(m.downgrade).toHaveBeenCalledWith(
      { targetPlanKey: "STARTER", retainedUserIds: [] },
      undefined,
    );
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("routes SUBSCRIBE to the subscribe mutation with the caller's live cycle", () => {
    const m = mutations();
    dispatchPlanChange(quote(change("SUBSCRIBE")), m);
    expect(m.subscribe).toHaveBeenCalledTimes(1);
    expect(m.subscribe).toHaveBeenCalledWith({ planKey: "BUSINESS", cycle: "MONTHLY" }, undefined);
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.downgrade).not.toHaveBeenCalled();
  });

  // The live toggle wins over the quote's echoed cycle. Committing `preview.cycle` bought
  // the cycle of the last SUCCESSFUL quote, so a commit fired after a cycle toggle but
  // before (or after a failed) re-quote subscribed on the term the tenant just left —
  // an ANNUAL selection billed and period-set as MONTHLY.
  it("subscribes on the LIVE cycle, not the cycle the quote echoed back", () => {
    const m = mutations("ANNUAL");
    dispatchPlanChange(quote(change("SUBSCRIBE"), "BUSINESS", "MONTHLY"), m);
    expect(m.subscribe).toHaveBeenCalledWith({ planKey: "BUSINESS", cycle: "ANNUAL" }, undefined);
  });

  it("uses the live cycle for a null `change` too (no tenant context)", () => {
    const m = mutations("ANNUAL");
    dispatchPlanChange(quote(null, "BUSINESS", "MONTHLY"), m);
    expect(m.subscribe).toHaveBeenCalledWith({ planKey: "BUSINESS", cycle: "ANNUAL" }, undefined);
  });

  it("treats a null `change` (no tenant context, e.g. SUPER_ADMIN) as SUBSCRIBE", () => {
    const m = mutations();
    dispatchPlanChange(quote(null), m);
    expect(m.subscribe).toHaveBeenCalledWith({ planKey: "BUSINESS", cycle: "MONTHLY" }, undefined);
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.downgrade).not.toHaveBeenCalled();
  });

  it("fires nothing for NOOP (the caller disables its own commit control)", () => {
    const m = mutations();
    dispatchPlanChange(quote(change("NOOP")), m);
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.downgrade).not.toHaveBeenCalled();
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("fires nothing for KEEP_CURRENT — it commits through resume at the caller, never subscribe", () => {
    const m = mutations();
    dispatchPlanChange(quote(change("KEEP_CURRENT")), m);
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.downgrade).not.toHaveBeenCalled();
    // Routing KEEP_CURRENT to subscribe() would reset the current period.
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  // A custom (ENTERPRISE) plan on either side is never self-served: the API answers
  // CONTACT_SALES, and the dispatch must post NOTHING — routing it to subscribe/downgrade
  // is how a negotiated contract gets re-priced from the catalog.
  it("fires nothing for CONTACT_SALES and reports the sales hand-off", () => {
    const m = mutations();
    const result = dispatchPlanChange(quote(change("CONTACT_SALES")), m);
    expect(result).toEqual({ outcome: "contact-sales" });
    expect(m.upgrade).not.toHaveBeenCalled();
    expect(m.downgrade).not.toHaveBeenCalled();
    expect(m.subscribe).not.toHaveBeenCalled();
  });

  it("passes the caller's onSuccess/onError through unchanged", () => {
    const m = mutations();
    const options = { onSuccess: jest.fn(), onError: jest.fn() };
    dispatchPlanChange(quote(change("UPGRADE")), m, options);
    expect(m.upgrade).toHaveBeenCalledWith({ planKey: "BUSINESS" }, options);
  });
});
