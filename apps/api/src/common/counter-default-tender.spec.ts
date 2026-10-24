import { defaultCounterTender } from "@routeflow/types";

/**
 * SA-933 / W-822(a): the counter's DEFAULT tender follows the customer's EFFECTIVE payment terms, by the same one rule the
 * server's resolveDefaultTerms() applies (the customer's own terms win; otherwise the tenant default; otherwise "Net 30").
 * `defaultCounterTender` lives in `packages/types/counter-default-tender.ts`, which has no Jest runner of its own (same as
 * `post-delivery-invoice-prompt.ts`), so the pinned suite lives here and imports the package like any other consumer.
 */
describe("defaultCounterTender", () => {
  it("a walk-in (no customer) is CASH, whatever the tenant default says", () => {
    expect(defaultCounterTender({ customer: null, tenantDefaultTerms: "Net 30" })).toBe("CASH");
  });

  it("an absent customer is CASH too", () => {
    expect(defaultCounterTender({ tenantDefaultTerms: "Net 60" })).toBe("CASH");
    expect(defaultCounterTender({ customer: undefined, tenantDefaultTerms: null })).toBe("CASH");
  });

  it("Due on Receipt is CASH", () => {
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "Due on Receipt" },
        tenantDefaultTerms: "Net 30",
      }),
    ).toBe("CASH");
  });

  it("Net 30 is ON_ACCOUNT, and so is any Net N above zero", () => {
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "Net 30" },
        tenantDefaultTerms: "Due on Receipt",
      }),
    ).toBe("ON_ACCOUNT");
    for (const terms of ["Net 15", "Net 45", "Net 60", "Net 90", "Net 1"]) {
      expect(
        defaultCounterTender({
          customer: { defaultPaymentTerms: terms },
          tenantDefaultTerms: null,
        }),
      ).toBe("ON_ACCOUNT");
    }
  });

  it("Net 0 owes nothing later, so it is CASH", () => {
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "Net 0" },
        tenantDefaultTerms: null,
      }),
    ).toBe("CASH");
  });

  it("the customer's own terms override the tenant default, in both directions", () => {
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "Due on Receipt" },
        tenantDefaultTerms: "Net 30",
      }),
    ).toBe("CASH");
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "Net 15" },
        tenantDefaultTerms: "Due on Receipt",
      }),
    ).toBe("ON_ACCOUNT");
  });

  it("a customer with null, empty or blank terms falls back to the tenant default", () => {
    for (const own of [null, undefined, "", "   "]) {
      expect(
        defaultCounterTender({
          customer: { defaultPaymentTerms: own },
          tenantDefaultTerms: "Due on Receipt",
        }),
      ).toBe("CASH");
      expect(
        defaultCounterTender({
          customer: { defaultPaymentTerms: own },
          tenantDefaultTerms: "Net 30",
        }),
      ).toBe("ON_ACCOUNT");
    }
  });

  it("with neither set it follows the server's own fallback, Net 30: ON_ACCOUNT", () => {
    expect(
      defaultCounterTender({ customer: { defaultPaymentTerms: null }, tenantDefaultTerms: null }),
    ).toBe("ON_ACCOUNT");
    expect(defaultCounterTender({ customer: {}, tenantDefaultTerms: "" })).toBe("ON_ACCOUNT");
  });

  it("is case- and spacing-tolerant about the term text", () => {
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: " due on receipt " },
        tenantDefaultTerms: "Net 30",
      }),
    ).toBe("CASH");
    expect(
      defaultCounterTender({
        customer: { defaultPaymentTerms: "net 30" },
        tenantDefaultTerms: null,
      }),
    ).toBe("ON_ACCOUNT");
  });
});
