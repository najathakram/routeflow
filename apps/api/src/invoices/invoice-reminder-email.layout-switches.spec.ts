import { sendReminder } from "./invoice-reminder-email";

/**
 * R6a (#3686 read 1 SHOULD, probe 2b): a reminder body ignores the Paid / Balance Due switches. With both set, the
 * payload `sendReminder` hands to `sendInvoice` carries neither flag, and still carries the paid figure and the
 * balance, so the reminder says what is owed. Driven through the real payload builder.
 */
function deps(config: Record<string, string>) {
  const sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
  const d = {
    prisma: {
      forTenant: () => ({
        invoice: {
          findUnique: jest.fn().mockResolvedValue({
            id: "inv-1",
            status: "PARTIAL",
            subtotal: 100,
            taxAmount: 0,
            discount: 0,
            shippingFee: 0,
            total: 100,
            invoiceNumber: "INV-1",
            issueDate: new Date("2026-11-01T00:00:00Z"),
            dueDate: new Date("2026-11-30T00:00:00Z"),
            customer: { email: "buyer@acme.test", businessName: "Acme Foods" },
            items: [],
            payments: [{ id: "p1", method: "CASH", amount: 30, status: "PAID", creditNote: null }],
          }),
        },
      }),
    },
    emailService: { isEmailConfigured: jest.fn().mockResolvedValue(true), sendInvoice },
    pdfService: { getOrGenerate: jest.fn().mockResolvedValue(undefined) },
    storage: { download: jest.fn() },
    systemConfig: {
      get: jest.fn().mockResolvedValue(null),
      getAll: jest.fn().mockResolvedValue(config),
    },
    logger: { warn: jest.fn() },
  };
  return { d: d as never, sendInvoice };
}

describe("sendReminder: the Paid / Balance Due switches never reach the reminder", () => {
  it("with both switches set, the payload carries neither flag and keeps the paid figure and balance", async () => {
    const { d, sendInvoice } = deps({
      "invoice.hideAmountPaid": "true",
      "invoice.hideBalanceDue": "true",
    });
    await sendReminder(d, "inv-1");
    const payload = sendInvoice.mock.calls[0][0];
    expect(payload.isReminder).toBe(true);
    expect(payload).not.toHaveProperty("hideAmountPaid");
    expect(payload).not.toHaveProperty("hideBalanceDue");
    expect(payload.totalPaid).toBe(30);
    expect(payload.balanceDue).toBe(70);
  });

  it("the payload is the same with the switches set as without them", async () => {
    const on = deps({ "invoice.hideAmountPaid": "true", "invoice.hideBalanceDue": "true" });
    const off = deps({});
    await sendReminder(on.d, "inv-1");
    await sendReminder(off.d, "inv-1");
    expect(on.sendInvoice.mock.calls[0][0]).toEqual(off.sendInvoice.mock.calls[0][0]);
  });
});
