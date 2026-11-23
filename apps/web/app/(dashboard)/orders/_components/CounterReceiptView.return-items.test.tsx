import * as React from "react";
import { render, screen } from "@testing-library/react";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

/**
 * SA-1211 A1.1 / A1.4 (VF-6): the counter receipt of a $100 sale with a $40 return lists the returned items with their
 * reason (the server's stored return lines, used as given) and prints "Credit $40.00": the one word, never "Store credit".
 */
const sale = (over: Record<string, unknown>) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 100,
      paid: 100,
      balanceDue: 0,
      method: "CASH",
      paymentRecorded: true,
      ...over,
    } as never,
    lines: [{ tempId: "a", name: "Big", unitPrice: 100, qty: 1 }],
    enteredTender: null,
    profile: { taxRate: 0 },
    now: new Date("2026-10-07T15:15:00.000Z"),
  });
const view = (over: Record<string, unknown>) =>
  render(<CounterReceiptView model={sale(over)} logoUrl={null} />);

const ITEMS = [
  { name: "Acme Snack", qty: 2, reason: "DAMAGED", kind: "INLINE" as const, line: null },
  { name: "Acme Soda", qty: 1, reason: null },
];
// SA-1231 H1: one box of a split line (24 pcs) back through the till
const BOX = {
  name: "Acme Case",
  qty: 24,
  reason: "DAMAGED",
  kind: "INLINE" as const,
  line: { unitLabel: null, unitsPerBox: 24, boxes: 1, pieces: 0, qty: 1 },
};
const NONE = { applied: 0, refunded: 0, kept: 0, used: 0, pending: false };

describe("the counter receipt of a sale with a return (SA-1211 A1.1)", () => {
  it("lists each returned item with its reason, from the server's lines", () => {
    view({
      tenderPaid: 60,
      tenderMethods: [{ method: "CASH", amount: 60 }],
      returnCredit: 40,
      returnLines: { ...NONE, applied: 40 },
      returnItems: ITEMS,
    });
    const rows = screen.getAllByTestId("receipt-return-item").map((r) => r.textContent);
    expect(rows).toEqual(["Acme Snack · 2 pcs · Damaged", "Acme Soda · 1 pcs · No reason given"]);
  });

  it("SA-1231: one returned box reads its unit, never a bare 24", () => {
    view({
      tenderPaid: 52,
      tenderMethods: [{ method: "CASH", amount: 52 }],
      returnCredit: 48,
      returnLines: { ...NONE, applied: 48 },
      returnItems: [BOX],
    });
    expect(screen.getAllByTestId("receipt-return-item").map((r) => r.textContent)).toEqual([
      "Acme Case · 24 pcs (1 box) · Damaged",
    ]);
  });

  it("an INLINE return on a legacy line (no split) reads 24 pcs, never a bare 24", () => {
    view({
      tenderPaid: 52,
      tenderMethods: [{ method: "CASH", amount: 52 }],
      returnLines: { ...NONE, applied: 48 },
      returnItems: [
        { ...BOX, line: { ...BOX.line, boxes: null, pieces: null, unitsPerBox: null } },
      ],
    });
    expect(screen.getByTestId("receipt-return-item")).toHaveTextContent(
      "Acme Case · 24 pcs · Damaged",
    );
  });

  it("credit kept on the account prints once: master's Credit kept line, no second credit row (SA-1231 M1)", () => {
    view({
      tenderPaid: 100,
      tenderMethods: [{ method: "CASH", amount: 100 }],
      returnLines: { ...NONE, kept: 40 },
      returnItems: ITEMS,
    });
    expect(screen.getByTestId("receipt-credit-kept")).toHaveTextContent(
      "Credit kept $40.00 (returned items)",
    );
    expect(document.body.textContent?.match(/\$40\.00/g)).toHaveLength(1);
  });

  it("a credit applied to the sale shows once, as the Returned row: no second Credit row", () => {
    view({
      tenderPaid: 60,
      tenderMethods: [{ method: "CASH", amount: 60 }],
      returnCredit: 40,
      returnLines: { ...NONE, applied: 40 },
      returnItems: ITEMS,
    });
    expect(screen.getByTestId("receipt-returned")).toHaveTextContent("−$40.00");
    // A1.7: each return dollar prints once. The $40 is the Returned row; the payment is only Cash $60.00
    expect(screen.getByTestId("receipt-method")).toHaveTextContent(/^Payment methodCash \$60\.00$/);
    expect(document.body.textContent?.match(/\$40\.00/g)).toHaveLength(1);
  });

  it("a credit that is a tender reads Credit $40.00 in the Payment method, never Store credit", () => {
    view({
      tenderPaid: 100,
      tenderMethods: [
        { method: "CASH", amount: 60 },
        { method: "STORE_CREDIT", amount: 40 },
      ],
      returnLines: NONE,
      returnItems: ITEMS,
    });
    expect(screen.getByTestId("receipt-method")).toHaveTextContent("Cash $60.00 + Credit $40.00");
    expect(screen.queryByText(/Store credit/)).toBeNull();
    // the Payment method line already shows it: the $40 appears once on the paper
    expect(document.body.textContent?.match(/Credit \$40\.00/g)).toHaveLength(1);
  });

  it("a sale with no return prints no returned-items block", () => {
    view({ tenderPaid: 100, tenderMethods: [{ method: "CASH", amount: 100 }], returnLines: NONE });
    expect(screen.queryByTestId("receipt-return-items")).toBeNull();
  });
});
