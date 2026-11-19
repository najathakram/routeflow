import { InvoicesService } from "./invoices.service";

/**
 * R6a / #3686 read 1 (probe 2c) and read 2 (probe P4): the Paid / Balance Due switches change the invoice PDF and the
 * invoice email only. The invoice detail (`findOne`) that the staff page, the buyer portal and mobile all read returns
 * the same paid figures (`paidAmount`, credit, advance), balance and payment rows whatever the switches say, and carries neither switch.
 */
const SWITCHES_ON = { "invoice.hideAmountPaid": "true", "invoice.hideBalanceDue": "true" };

const stored = () => ({
  id: "inv-1",
  customerId: "cust-1",
  status: "PARTIAL",
  subtotal: 200,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  total: 200,
  amountPaid: 50,
  dueDate: null,
  paidAt: null,
  items: [],
  payments: [
    {
      id: "p1",
      method: "CASH",
      amount: 50,
      status: "PAID",
      paidAt: new Date("2026-11-01T12:00:00Z"),
      creditNote: null,
    },
  ],
});

const makeService = (config: Record<string, string>) => {
  const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
    ...Array(14).fill(undefined),
  );
  Object.assign(service, {
    prisma: {
      getTenantId: () => null,
      forTenant: () => ({
        invoice: { findUnique: jest.fn().mockResolvedValue(stored()) },
        customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
        auditLog: {
          groupBy: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      }),
    },
    systemConfig: {
      get: jest.fn().mockResolvedValue(null),
      getAll: jest.fn().mockResolvedValue(config),
    },
  });
  return service;
};

const VIEWERS = [
  ["staff", undefined],
  ["buyer", { sub: "u-buyer", role: "CUSTOMER", tenantId: "t1" }],
] as const;

describe("findOne: the Paid / Balance Due switches never reach the invoice detail", () => {
  it.each(VIEWERS)(
    "%s: same balance, paid figures and payment rows with both switches on and off",
    async (_label, user) => {
      const off: any = await makeService({}).findOne("inv-1", user as any);
      const on: any = await makeService(SWITCHES_ON).findOne("inv-1", user as any);
      const figures = (x: any) => ({
        total: Number(x.total),
        amountPaid: x.amountPaid == null ? x.amountPaid : Number(x.amountPaid),
        paidAmount: x.paidAmount,
        creditApplied: x.creditApplied,
        advanceApplied: x.advanceApplied,
        balanceDue: x.balanceDue,
        payments: x.payments?.map((p: any) => [p.id, Number(p.amount), p.status]),
      });
      // the fixture's own figures, so a reader that nulls them under both states is caught too
      expect(figures(off).balanceDue).toBe(150);
      expect(figures(off).paidAmount).toBe(50);
      expect(figures(off).payments).toEqual([["p1", 50, "PAID"]]);
      expect(figures(on)).toEqual(figures(off));
    },
  );

  it.each(VIEWERS)("%s: the wire carries neither switch", async (_label, user) => {
    const on: any = await makeService(SWITCHES_ON).findOne("inv-1", user as any);
    expect(on).not.toHaveProperty("hideAmountPaid");
    expect(on).not.toHaveProperty("hideBalanceDue");
  });
});
