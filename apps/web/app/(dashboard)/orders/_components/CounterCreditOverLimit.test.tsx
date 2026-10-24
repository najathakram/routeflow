import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { CounterSaleResponse } from "@routeflow/types";
import { CounterCreditOverLimit, creditOverLimitSentence } from "./CounterCreditOverLimit";

/**
 * SA-849 (S1 S-1): the credit gate counted this sale's till tender, the tender did not record, and without it the customer
 * is over their limit (an ENFORCED tenant). The till says so inside the "payment not recorded" state, as one line; the
 * sale stands and recording the payment clears it. Nothing shows otherwise.
 */
const receipt = (over: Partial<CounterSaleResponse> = {}): CounterSaleResponse =>
  ({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 100,
    paid: 0,
    balanceDue: 100,
    method: "CASH",
    paymentRecorded: false,
    paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
    ...over,
  }) as CounterSaleResponse;

describe("CounterCreditOverLimit", () => {
  it("the one sentence: the customer, the exposure and the limit, in money", () => {
    expect(creditOverLimitSentence("Acme Co", { limit: 50, exposure: 100 })).toBe(
      "Until this payment is recorded, Acme Co is over their credit limit ($100.00 of $50.00).",
    );
    expect(creditOverLimitSentence(null, { limit: 50, exposure: 100 })).toBe(
      "Until this payment is recorded, the customer is over their credit limit ($100.00 of $50.00).",
    );
  });

  it("shows inside the not-recorded state when the server answers creditOverLimit", () => {
    render(
      <CounterCreditOverLimit
        receipt={receipt({ creditOverLimit: { limit: 50, exposure: 100 } })}
        customerName="Acme Co"
      />,
    );
    expect(screen.getByTestId("counter-credit-over-limit")).toHaveTextContent(
      "Until this payment is recorded, Acme Co is over their credit limit ($100.00 of $50.00).",
    );
  });

  it("nothing without the field, and nothing once the payment is recorded", () => {
    const { container, rerender } = render(
      <CounterCreditOverLimit receipt={receipt()} customerName="Acme Co" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <CounterCreditOverLimit
        receipt={receipt({ paymentRecorded: true, creditOverLimit: { limit: 50, exposure: 100 } })}
        customerName="Acme Co"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
