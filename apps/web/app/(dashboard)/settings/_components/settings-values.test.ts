import type { SubscriptionView } from "@routeflow/types";
import {
  attentionItems,
  businessStatus,
  counterValue,
  invoicingValue,
  oversellValue,
  peopleValue,
  routeValue,
  stripeValue,
  timeZoneValue,
} from "./settings-values";

/** Trailing values on the hub rows: only what the data really says; a missing piece shows nothing. */

describe("trailing values", () => {
  it("time zone", () => {
    expect(timeZoneValue({ timezone: "America/Chicago" })).toBe("America/Chicago");
    expect(timeZoneValue({ timezone: "" })).toBeUndefined();
    expect(timeZoneValue({})).toBeUndefined();
    expect(timeZoneValue(undefined)).toBeUndefined();
  });

  it("invoicing is 'prefix · terms'; terms alone when the prefix is unset; nothing without terms", () => {
    const num = [{ docType: "INVOICE", prefix: "INV-", configured: true }];
    expect(invoicingValue({ defaultTerms: "Net 30" }, num)).toBe("INV- · Net 30");
    expect(invoicingValue({ defaultTerms: "Net 30" }, undefined)).toBe("Net 30");
    expect(
      invoicingValue({ defaultTerms: "Net 15" }, [
        { docType: "INVOICE", prefix: "", configured: false },
      ]),
    ).toBe("Net 15");
    expect(invoicingValue({ defaultTerms: "" }, num)).toBeUndefined();
    expect(invoicingValue(undefined, num)).toBeUndefined();
  });

  it("out-of-stock ordering is Allowed only for the exact string 'backorder'", () => {
    expect(oversellValue({ buyerOversell: "backorder" })).toBe("Allowed");
    expect(oversellValue({ buyerOversell: "off" })).toBe("Off");
    expect(oversellValue({ buyerOversell: "weird" as never })).toBe("Off");
    expect(oversellValue(undefined)).toBeUndefined();
  });

  it("route defaults is 'N min · HH:MM' and needs both", () => {
    expect(routeValue({ serviceTimeMinutes: 10, defaultStartTime: "08:00" })).toBe(
      "10 min · 08:00",
    );
    expect(routeValue({ serviceTimeMinutes: 10 } as never)).toBeUndefined();
    expect(routeValue(undefined)).toBeUndefined();
  });

  it("card payments is Connected / Not connected", () => {
    expect(stripeValue({ connected: true })).toBe("Connected");
    expect(stripeValue({ connected: false })).toBe("Not connected");
    expect(stripeValue({} as never)).toBeUndefined();
    expect(stripeValue(undefined)).toBeUndefined();
  });

  it("counter sales is On / Off, nothing while unknown", () => {
    expect(counterValue(true)).toBe("On");
    expect(counterValue(false)).toBe("Off");
    expect(counterValue(undefined)).toBeUndefined();
  });

  it("people", () => {
    expect(peopleValue(4)).toBe("4 people");
    expect(peopleValue(1)).toBe("1 person");
    expect(peopleValue(0)).toBeUndefined();
    expect(peopleValue(undefined)).toBeUndefined();
    expect(peopleValue(Number.NaN)).toBeUndefined();
  });

  it("never prints the word 'undefined'", () => {
    const all = [
      timeZoneValue({}),
      invoicingValue({}, [{ docType: "INVOICE", prefix: undefined as never, configured: true }]),
      routeValue({} as never),
    ].filter(Boolean);
    for (const v of all) expect(v).not.toMatch(/undefined|NaN/);
  });
});

const sub = (over: Partial<SubscriptionView>): SubscriptionView =>
  ({
    planKey: "growth",
    planName: "Growth",
    status: "ACTIVE",
    cycle: "MONTHLY",
    monthlyPrice: 149,
    annualPrice: null,
    isCustom: false,
    renewalAt: null,
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    paymentRequired: false,
    ...over,
  }) as SubscriptionView;

describe("Business card status", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("Active", () => {
    expect(businessStatus(sub({ billingState: "current" }), "admin", now)).toMatchObject({
      plan: "Growth",
      pill: { label: "Active", tone: "success" },
      pay: null,
    });
  });

  it("Trial · N days left", () => {
    const s = businessStatus(
      sub({ status: "TRIAL", trialEndsAt: "2026-10-18T12:00:00Z" }),
      "admin",
      now,
    );
    expect(s?.pill).toEqual({ label: "Trial · 6 days left", tone: "info" });
    expect(
      businessStatus(sub({ status: "TRIAL", trialEndsAt: "2026-10-13T12:00:00Z" }), "admin", now)
        ?.pill?.label,
    ).toBe("Trial · 1 day left");
  });

  it("Payment due carries Pay $X for an admin only", () => {
    const due = sub({
      billingState: "due",
      openInvoiceAmount: 149,
      payNowAmount: 149,
      outstandingTotal: 149,
      payNowUrl: "https://pay.example/inv_1",
    });
    expect(businessStatus(due, "admin", now)).toMatchObject({
      pill: { label: "Payment due", tone: "warning" },
      pay: { label: "Pay $149.00", url: "https://pay.example/inv_1" },
    });
    expect(businessStatus(due, "staff", now)?.pay).toBeNull();
  });

  it("Read-only", () => {
    expect(
      businessStatus(sub({ status: "READ_ONLY", readOnlyReason: "payment_overdue" }), "admin", now)
        ?.pill,
    ).toEqual({ label: "Read-only", tone: "danger" });
  });

  it("no status when the subscription is unknown or the role has none", () => {
    expect(businessStatus(undefined, "admin", now)).toBeNull();
    expect(businessStatus(sub({}), null, now)).toBeNull();
  });
});

describe("Needs attention", () => {
  const base = {
    isAdmin: true,
    status: null,
    remittance: { payToName: "Acme" },
    stripe: { connected: true },
  };

  it("is empty when nothing needs attention, and for operators", () => {
    expect(attentionItems(base)).toEqual([]);
    expect(
      attentionItems({ ...base, isAdmin: false, remittance: {}, stripe: { connected: false } }),
    ).toEqual([]);
  });

  it("lists payment due, unset How to pay and an unconnected Stripe, each with its link", () => {
    const items = attentionItems({
      isAdmin: true,
      status: {
        plan: "Growth",
        pill: { label: "Payment due", tone: "info" },
        pay: null,
        due: true,
      },
      remittance: {},
      stripe: { connected: false },
    });
    expect(items.map((i) => i.href)).toEqual([
      "/settings/billing",
      "/settings?tab=remittance",
      "/settings#card-payments",
    ]);
  });

  it("apple-ux U1: customers without a state are flagged first, for admins AND operators", () => {
    const state = { customersTotal: 8, truncated: false };
    const href = "/settings/restrictions#customers-without-state";
    expect(attentionItems({ ...base, unknownState: state })[0]).toEqual({
      id: "customers-without-state",
      label: "8 customers need a state",
      href,
    });
    // operators fix customer states too (owner ruling); they get this row and nothing else
    expect(
      attentionItems({
        ...base,
        isAdmin: false,
        remittance: {},
        stripe: { connected: false },
        unknownState: state,
      }),
    ).toEqual([{ id: "customers-without-state", label: "8 customers need a state", href }]);
    expect(attentionItems({ ...base, unknownState: { customersTotal: 1 } })[0].label).toBe(
      "1 customer needs a state",
    );
  });

  it("apple-ux U1: a truncated sweep still raises the row; zero (or not loaded) raises nothing", () => {
    expect(
      attentionItems({ ...base, unknownState: { customersTotal: 0, truncated: true } })[0],
    ).toMatchObject({
      id: "customers-without-state",
      label: "Some customers may need a state",
    });
    expect(
      attentionItems({ ...base, unknownState: { customersTotal: 0, truncated: false } }),
    ).toEqual([]);
    expect(attentionItems({ ...base, unknownState: null })).toEqual([]);
  });

  it("does not flag what is still loading or failed", () => {
    expect(
      attentionItems({ isAdmin: true, status: null, remittance: undefined, stripe: undefined }),
    ).toEqual([]);
  });
});
