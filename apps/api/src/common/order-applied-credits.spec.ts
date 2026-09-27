/**
 * #2404 (P0, epic #2400, SA-436 PR-3): the order's "Applied credits" panel is built from the
 * credit ACTUALLY on the order's invoices (every non-VOID CREDIT_NOTE payment on a non-VOID
 * invoice, automatic or manual) plus the hand-picked intents not yet applied. Before, it listed
 * the intents only, so a credit auto-applied on send was invisible on the order. One pure rule
 * (packages/types), shared by web and mobile.
 */
import { orderAppliedCredits, type OrderAppliedCreditsInput } from "@routeflow/types";

const CN = (id: string, n: string, reason: string | null = null) => ({
  id,
  creditNoteNumber: n,
  reason,
});

const base: OrderAppliedCreditsInput = {
  invoices: [
    {
      id: "inv-1",
      invoiceNumber: "INV-1",
      status: "SENT",
      payments: [
        {
          id: "p1",
          amount: "12.50",
          creditNoteId: "cn-a",
          autoApplied: true,
          creditNote: CN("cn-a", "CN-A", "old test credit"),
        },
        {
          id: "p2",
          amount: "5.00",
          creditNoteId: "cn-b",
          autoApplied: false,
          creditNote: CN("cn-b", "CN-B"),
        },
      ],
    },
    {
      id: "inv-2",
      invoiceNumber: "INV-2",
      status: "SENT",
      payments: [
        { id: "p3", amount: "3.25", creditNoteId: "cn-b", creditNote: CN("cn-b", "CN-B") },
      ],
    },
  ],
  orderCreditNotes: [
    { id: "oc-b", creditNoteId: "cn-b", amount: "8.25", creditNote: CN("cn-b", "CN-B") },
    {
      id: "oc-c",
      creditNoteId: "cn-c",
      amount: null,
      creditNote: CN("cn-c", "CN-C", "return R-9"),
    },
  ],
};

describe("orderAppliedCredits (#2404)", () => {
  it("lists every applied credit payment, automatic and manual, with its invoice", () => {
    const rows = orderAppliedCredits(base).filter((r) => r.kind === "applied");
    expect(rows).toEqual([
      expect.objectContaining({
        paymentId: "p1",
        creditNoteNumber: "CN-A",
        invoiceId: "inv-1",
        invoiceNumber: "INV-1",
        amount: 12.5,
        source: "automatic",
      }),
      expect.objectContaining({
        paymentId: "p2",
        creditNoteNumber: "CN-B",
        invoiceNumber: "INV-1",
        amount: 5,
        source: "manual",
      }),
      expect.objectContaining({
        paymentId: "p3",
        creditNoteNumber: "CN-B",
        invoiceNumber: "INV-2",
        amount: 3.25,
        source: "manual",
      }),
    ]);
  });

  it("an auto-applied credit with NO intent on the order still shows (the incident)", () => {
    const rows = orderAppliedCredits(base);
    expect(rows.some((r) => r.creditNoteId === "cn-a" && r.source === "automatic")).toBe(true);
    expect(base.orderCreditNotes!.some((oc) => oc.creditNoteId === "cn-a")).toBe(false);
  });

  it("a payment without autoApplied reads as manual (existing rows, SA-436)", () => {
    const row = orderAppliedCredits(base).find((r) => r.paymentId === "p3")!;
    expect(row.source).toBe("manual");
  });

  it("an intent already applied is not listed twice; an unapplied one shows as pending", () => {
    const pending = orderAppliedCredits(base).filter((r) => r.kind === "pending");
    expect(pending).toEqual([
      expect.objectContaining({
        creditNoteId: "cn-c",
        creditNoteNumber: "CN-C",
        requested: null,
        reason: "return R-9",
      }),
    ]);
  });

  it("VOID invoices and VOID / non-credit payments are excluded", () => {
    const rows = orderAppliedCredits({
      invoices: [
        {
          id: "v",
          invoiceNumber: "INV-V",
          status: "VOID",
          payments: [
            { id: "x", amount: "9", creditNoteId: "cn-v", creditNote: CN("cn-v", "CN-V") },
          ],
        },
        {
          id: "i",
          invoiceNumber: "INV-I",
          status: "PAID",
          payments: [
            {
              id: "y",
              amount: "4",
              creditNoteId: "cn-y",
              status: "VOID",
              creditNote: CN("cn-y", "CN-Y"),
            },
            { id: "z", amount: "7", creditNoteId: null, method: "CASH" },
            {
              id: "w",
              amount: "2",
              creditNoteId: "cn-w",
              method: "CREDIT_NOTE",
              creditNote: CN("cn-w", "CN-W"),
            },
          ],
        },
      ],
      orderCreditNotes: [],
    });
    expect(rows.map((r) => r.paymentId)).toEqual(["w"]);
  });

  it("an empty order gives an empty panel", () => {
    expect(orderAppliedCredits({ invoices: [], orderCreditNotes: [] })).toEqual([]);
    expect(orderAppliedCredits({})).toEqual([]);
  });
});
