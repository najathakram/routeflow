// OrdersService / InvoicesService pull ESM-only modules: mocks at the module boundary (as counter-sale.service.spec.ts).
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
const mockLock = { notAcquired: false };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (_opts: any, fn: () => Promise<unknown>) =>
    mockLock.notAcquired ? { acquired: false } : { acquired: true, value: await fn() },
}));
// SA-849: the post-tender re-check is spied at the boundary (its own rules: credit-after-tender.spec.ts).
const mockAfterTender = jest.fn();
jest.mock("../credit-limit-guard", () => ({
  ...jest.requireActual("../credit-limit-guard"),
  creditAfterTender: (...a: unknown[]) => mockAfterTender(...a),
}));
const mockDayClosed = { on: false };
jest.mock("./counter-tender-window", () => {
  const actual = jest.requireActual("./counter-tender-window");
  const { ConflictException } = jest.requireActual("@nestjs/common");
  return {
    ...actual,
    counterTenderPaidAt: async (...a: unknown[]) => {
      if (mockDayClosed.on)
        throw new ConflictException({ code: "COUNTER_SALE_DAY_CLOSED", message: "closed" });
      return actual.counterTenderPaidAt(...a);
    },
  };
});

import { Test } from "@nestjs/testing";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * SA-849 (S1 S-1) wiring: the counter sale's credit gate netted the till tender; when that tender then does NOT fully
 * record, the ONE post-tender re-check runs (never blocks, never reverses the sale) and an ENFORCED breach reaches the
 * response as `creditOverLimit`. Red on master: no re-check, no field.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };
const OVER = { limit: 50, exposure: 100 };

describe("CounterSaleService.ring: the credit re-check after a failed netted tender (SA-849)", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let recordPayment: jest.Mock;
  let invoices: any[];

  beforeEach(async () => {
    mockAfterTender.mockReset().mockResolvedValue(OVER);
    mockLock.notAcquired = false;
    mockDayClosed.on = false;
    prisma = createMockPrisma();
    invoices = [{ id: "inv-1", total: 100, status: "SENT", createdAt: new Date(1), payments: [] }];
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      invoices
        .find((i) => i.id === invoiceId)
        .payments.push({
          id: "pay-1",
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
        });
      return { id: invoiceId, createdPaymentId: "pay-1" };
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: false });
    prisma.order.findFirst.mockImplementation(async () => ({
      id: "ord-1",
      orderNumber: "ORD-1",
      total: 100,
      counterCashTendered: null,
    }));
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        {
          provide: OrdersService,
          useValue: {
            createSale: jest.fn(async () => ({ id: "inv-1", orderId: "ord-1" })),
            findReplayCandidateByKey: jest.fn(async () => null),
            entitlements: { hasFlag: async () => true },
          },
        },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: { getOrCreateWalkIn: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: async () => ({ methods: ["PICKUP"], counter: "optional" }) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const ring = (payment: unknown) =>
    service.ring({ customerId: "cust-1", items: [item], payment } as never, staff, "key-1");

  it("R1 a CASH tender that throws at recordPayment: the re-check runs with what was netted, and the breach is answered", async () => {
    recordPayment.mockRejectedValueOnce(new Error("payment-ref 503"));
    const r: any = await ring({ method: "CASH", amount: 100 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      customerId: "cust-1",
      orderId: "ord-1",
      total: 100,
      netted: 100,
      planError: "COUNTER_PAYMENT_NOT_RECORDED",
    });
    expect(r.creditOverLimit).toEqual(OVER);
  });

  it("R2 the tender recorded: no re-check, no field", async () => {
    const r: any = await ring({ method: "CASH", amount: 100 });
    expect(r.paymentRecorded).toBe(true);
    expect(mockAfterTender).not.toHaveBeenCalled();
    expect(r.creditOverLimit).toBeUndefined();
  });

  it("R5 the tender lock not taken: the re-check runs", async () => {
    mockLock.notAcquired = true;
    const r: any = await ring({ method: "CARD", amount: 100 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(r.creditOverLimit).toEqual(OVER);
  });

  it("R6 a closed day's 409 (after the sale committed): the re-check runs (audit only) and the 409 is unchanged", async () => {
    mockDayClosed.on = true;
    const err: any = await ring({ method: "CASH", amount: 100 }).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      planError: "COUNTER_SALE_DAY_CLOSED",
    });
  });

  it.each([
    ["on account", { method: "ON_ACCOUNT" }],
    ["a check dated after today", { method: "CHECK", reference: "1042", checkDate: "2999-01-01" }],
  ])("R8 %s nets 0: no re-check even when nothing records", async (_n, payment) => {
    recordPayment.mockRejectedValue(new Error("boom"));
    await ring(payment).catch(() => undefined);
    expect(mockAfterTender).not.toHaveBeenCalled();
  });
});
