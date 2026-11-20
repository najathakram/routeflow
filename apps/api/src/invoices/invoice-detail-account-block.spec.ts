import { InvoicesService } from "./invoices.service";

/**
 * SA-1197 (Q7, C5, T16): the invoice detail (`findOne`) carries the server's account rows for the staff invoice page.
 * A screen always shows Balance due, so the rows are the full form whatever `hideBalanceDue` says. Until PR-2 adds the
 * buyer allowlist row, the buyer projection drops the field (the allowlist's safe default).
 */
const stored = (over: Record<string, unknown> = {}) => ({
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
  createdAt: new Date("2026-11-01T12:00:00Z"),
  customer: { id: "cust-1", businessName: "Acme Buyer", isWalkIn: null },
  items: [],
  payments: [
    {
      id: "p1",
      method: "CASH",
      amount: 50,
      status: "PAID",
      paidAt: new Date("2026-11-01T12:00:00Z"),
      createdAt: new Date("2026-11-01T12:00:00Z"),
      creditNote: null,
    },
  ],
  ...over,
});

const makeService = (config: Record<string, string>, over: Record<string, unknown> = {}) => {
  const findMany = jest
    .fn()
    .mockResolvedValue([
      { customerId: "cust-1", total: 30, status: "SENT", dueDate: null, payments: [] },
    ]);
  const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
    ...Array(14).fill(undefined),
  );
  Object.assign(service, {
    prisma: {
      getTenantId: () => null,
      forTenant: () => ({
        invoice: { findUnique: jest.fn().mockResolvedValue(stored(over)), findMany },
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
  return { service, findMany };
};

const ON = { "invoice.showAccountBalance": "true" };
const BUYER = { sub: "u-buyer", role: "CUSTOMER", tenantId: "t1" };

describe("findOne: the account block on the invoice detail (SA-1197)", () => {
  it("staff, switch on: the full rows; This invoice equals the detail's own balanceDue (T16)", async () => {
    const { service, findMany } = makeService(ON);
    const out: any = await service.findOne("inv-1");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(out.accountBlock.map((r: any) => [r.kind, r.amount])).toEqual([
      ["heading", null],
      ["others", 30],
      ["thisInvoice", 150],
      ["openBalance", 180],
    ]);
    expect(out.accountBlock.find((r: any) => r.kind === "thisInvoice").amount).toBe(out.balanceDue);
  });

  it("a screen always prints the full form, even when the documents hide Balance Due (C5)", async () => {
    const { service } = makeService({ ...ON, "invoice.hideBalanceDue": "true" });
    const out: any = await service.findOne("inv-1");
    expect(out.accountBlock.map((r: any) => r.kind)).toEqual([
      "heading",
      "others",
      "thisInvoice",
      "openBalance",
    ]);
  });

  it("T18: switch off -> no rows and no open-set read", async () => {
    const { service, findMany } = makeService({});
    const out: any = await service.findOne("inv-1");
    expect(out.accountBlock).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("T9: the walk-in customer's invoice carries no rows", async () => {
    const { service, findMany } = makeService(ON, {
      customer: { id: "cust-1", businessName: "Walk-in", isWalkIn: true },
    });
    const out: any = await service.findOne("inv-1");
    expect(out.accountBlock).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("PR-1: the buyer's projection does not carry the field yet (allowlist default; PR-2 adds it)", async () => {
    const { service } = makeService(ON);
    const out: any = await service.findOne("inv-1", BUYER as any);
    expect(out).not.toHaveProperty("accountBlock");
  });
});
