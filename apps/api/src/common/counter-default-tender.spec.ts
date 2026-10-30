import { defaultCounterTender } from "@routeflow/types";
import { TERM_DAYS } from "../invoices/invoices.service";

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

/**
 * Parity with the server: the default follows the SAME term table `resolveDefaultTerms()` prices a due date from. Every term the
 * server knows is CASH when it is due on receipt (0 days) and ON_ACCOUNT otherwise; a term it cannot price is billed as 30 days.
 */
describe("defaultCounterTender: parity with the server's TERM_DAYS", () => {
  it("knows every term the server prices (the table is not empty)", () => {
    expect(Object.keys(TERM_DAYS).length).toBeGreaterThanOrEqual(5);
  });

  it.each(Object.entries(TERM_DAYS))("%s (%i days)", (terms, days) => {
    const expected = days > 0 ? "ON_ACCOUNT" : "CASH";
    // as the customer's own terms, and as the tenant default for a customer with none
    expect(defaultCounterTender({ customer: { defaultPaymentTerms: terms } })).toBe(expected);
    expect(
      defaultCounterTender({ customer: { defaultPaymentTerms: null }, tenantDefaultTerms: terms }),
    ).toBe(expected);
  });

  it("a term the server cannot price is thirty days there, so ON_ACCOUNT here", () => {
    expect(TERM_DAYS["Net 7 (special)"] ?? 30).toBe(30);
    expect(defaultCounterTender({ customer: { defaultPaymentTerms: "Net 7 (special)" } })).toBe(
      "ON_ACCOUNT",
    );
  });
});
