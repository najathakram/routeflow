// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load; mocked at the boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
// The shared Postgres advisory lock is a pass-through with the same contract (fn runs under the lock).
const mockLockCalls: Array<{ family: string; key: string }> = [];
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLockCalls.push({ family: opts.family, key: opts.key });
    return { acquired: true, value: await fn() };
  },
}));

import { Test } from "@nestjs/testing";
import type { FulfilmentCapability } from "@routeflow/types";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { legGroupId } from "./counter-sale-tender";

/**
 * Split payments on POST /orders/counter-sale (service level, collaborators mocked at the boundary).
 * `createSale` stands in for create(): it prices, calls `beforeWrite({ total })`, THEN "writes" (sets `written`),
 * so a pre-write refusal is proven by `written` staying false (no order row). The payment mock keeps a real
 * ledger per invoice so the tender, its group ids and the read-back are judged end to end.
 */
const cap = {
  counter: "always",
  methods: ["PICKUP"],
  consistent: true,
} as unknown as FulfilmentCapability;
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };

type Pay = {
  id: string;
  amount: number;
  method: string;
  status: string;
  paymentGroupId?: string | null;
};
type Inv = { id: string; total: number; status: string; createdAt: Date; payments: Pay[] };

describe("CounterSaleService.ring: split payments", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: Inv[];
  let written: boolean;
  let createSale: jest.Mock;
  let recordPayment: jest.Mock;
  let walkIns: { getOrCreateWalkIn: jest.Mock };

  const inv = (id: string, total: number, at: number, payments: Pay[] = []): Inv => ({
    id,
    total,
    status: "SENT",
    createdAt: new Date(2026, 9, 4, 12, 0, at),
    payments,
  });
  const total = () => invoices.reduce((s, i) => s + i.total, 0);
  const walkInSale = (extra: any) => ({ walkIn: true, items: [item], ...extra }) as never;
  const named = (extra: any) => ({ customerId: "cust-1", items: [item], ...extra }) as never;
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a rejection");
  };

  beforeEach(async () => {
    mockLockCalls.length = 0;
    prisma = createMockPrisma();
    invoices = [inv("inv-1", 70, 1)];
    written = false;
    createSale = jest.fn(async (_dto: any, _u: any, sale: any) => {
      await sale?.beforeWrite?.({ total: total() });
      written = true;
      return { id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" };
    });
    let seq = 0;
    recordPayment = jest.fn(async (invoiceId: string, dto: any, opts?: any) => {
      const target = invoices.find((i) => i.id === invoiceId)!;
      target.payments.push({
        id: `pay-${++seq}`,
        amount: dto.amount,
        method: dto.method,
        status: "PAID",
        paymentGroupId: opts?.paymentGroupId ?? null,
      });
      return { id: invoiceId, createdPaymentId: `pay-${seq}` };
    });
    walkIns = { getOrCreateWalkIn: jest.fn().mockResolvedValue("cust-walkin") };
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: true });
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    prisma.invoice.findMany.mockImplementation(async ({ where }: any = {}) =>
      invoices
        .filter((i) => !where?.status?.notIn?.includes(i.status))
        .map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        {
          provide: OrdersService,
          useValue: { createSale, findReplayCandidateByKey: jest.fn(async () => null) },
        },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: walkIns },
        { provide: PrismaService, useValue: prisma },
        { provide: FULFILMENT_CAPABILITY_READER, useValue: { get: jest.fn(async () => cap) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  describe("recording a split (test 1, test 4 at service level, test 8 service half)", () => {
    it("card 30 + cash 50 on a 70 sale: two rows, the cash row takes only what is owed, change 10", async () => {
      const r = await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30, reference: "auth-1" },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount, c[1].method])).toEqual([
        ["inv-1", 30, "CREDIT_CARD"],
        ["inv-1", 40, "CASH"],
      ]);
      expect(recordPayment.mock.calls[0][1].reference).toBe("auth-1");
      expect(r).toMatchObject({
        total: 70,
        paid: 70,
        balanceDue: 0,
        change: 10,
        method: "CARD",
        paymentRecorded: true,
      });
    });

    it("each leg's rows carry uuidv5(orderId:legIndex) from the server, written in the same recordPayment call", async () => {
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment.mock.calls.map((c) => c[2])).toEqual([
        { paymentGroupId: legGroupId("ord-1", 0) },
        { paymentGroupId: legGroupId("ord-1", 1) },
      ]);
      expect(legGroupId("ord-1", 0)).not.toBe(legGroupId("ord-1", 1));
      // never from the idempotency key: the same sale under another key groups identically
      recordPayment.mockClear();
      invoices = [inv("inv-1", 70, 1)];
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "another-key",
      );
      expect(recordPayment.mock.calls[0][2]).toEqual({ paymentGroupId: legGroupId("ord-1", 0) });
    });

    it("two invoices: card 30 + cash 50 on inv1 50 / inv2 20 -> card {inv1 30}, cash {inv1 20, inv2 20}, change 10", async () => {
      invoices = [inv("inv-1", 50, 1), inv("inv-2", 20, 2)];
      const r = await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
      );
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount, c[2].paymentGroupId])).toEqual(
        [
          ["inv-1", 30, legGroupId("ord-1", 0)],
          ["inv-1", 20, legGroupId("ord-1", 1)],
          ["inv-2", 20, legGroupId("ord-1", 1)],
        ],
      );
      expect(r).toMatchObject({ paid: 70, balanceDue: 0, change: 10, paymentRecorded: true });
    });

    it("the whole tender runs inside the ONE counter-tender lock keyed on the order (no second lock)", async () => {
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
      );
      expect(mockLockCalls).toEqual([{ family: "counter-tender", key: "ord-1" }]);
    });

    it("a named customer may part-pay a split: the rest stays on account, no change", async () => {
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 10 },
          ],
        }),
        staff,
      );
      expect(r).toMatchObject({ paid: 40, balanceDue: 30, paymentRecorded: true });
      expect(r.change).toBeUndefined();
    });

    it("a split whose cash leg is rung first is still taken non-cash first (card before cash)", async () => {
      await service.ring(
        walkInSale({
          payments: [
            { method: "CASH", amount: 50 },
            { method: "CARD", amount: 30 },
          ],
        }),
        staff,
      );
      expect(
        recordPayment.mock.calls.map((c) => [c[1].method, c[1].amount, c[2].paymentGroupId]),
      ).toEqual([
        ["CREDIT_CARD", 30, legGroupId("ord-1", 1)],
        ["CASH", 40, legGroupId("ord-1", 0)],
      ]);
    });
  });

  describe("pre-write refusals: 400 + code, and NO order row (test 2)", () => {
    const L = (method: string, amount?: number, reference?: string) => ({
      method,
      ...(amount != null ? { amount } : {}),
      ...(reference ? { reference } : {}),
    });
    const cases: Array<[string, any, string]> = [
      [
        "more than four legs",
        {
          payments: [
            L("CARD", 1),
            L("CARD", 1),
            L("CHECK", 1, "a"),
            L("CHECK", 1, "b"),
            L("CASH", 1),
          ],
        },
        "COUNTER_TOO_MANY_LEGS",
      ],
      [
        "a STORE_CREDIT leg",
        { payments: [L("STORE_CREDIT", 10), L("CASH", 60)] },
        "TENDER_METHOD_NOT_ALLOWED",
      ],
      [
        "ON_ACCOUNT mixed",
        { payments: [L("ON_ACCOUNT"), L("CASH", 70)] },
        "COUNTER_ON_ACCOUNT_NOT_SPLIT",
      ],
      ["two cash legs", { payments: [L("CASH", 30), L("CASH", 40)] }, "COUNTER_DUPLICATE_CASH_LEG"],
      [
        "a check without a number",
        { payments: [L("CHECK", 30), L("CASH", 40)] },
        "COUNTER_CHECK_NUMBER_REQUIRED",
      ],
      [
        "a split leg without an amount",
        { payments: [L("CARD"), L("CASH", 40)] },
        "COUNTER_LEG_AMOUNT_REQUIRED",
      ],
      [
        "a zero cash leg",
        { payments: [L("CARD", 70), L("CASH", 0)] },
        "COUNTER_LEG_AMOUNT_REQUIRED",
      ],
      [
        "a sub-cent amount",
        { payments: [L("CARD", 30.005), L("CASH", 40)] },
        "COUNTER_LEG_NOT_CENTS",
      ],
      [
        "non-cash adding up past the total",
        { payments: [L("CARD", 50), L("CHECK", 30, "9")] },
        "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      ],
      [
        "cash after non-cash already covers the total",
        { payments: [L("CARD", 70), L("CASH", 5)] },
        "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      ],
      [
        "a walk-in whose legs add up short",
        { payments: [L("CARD", 30), L("CASH", 30)] },
        "COUNTER_TENDER_SHORT",
      ],
      [
        "payment together with payments",
        { payment: L("CASH", 70), payments: [L("CARD", 30), L("CASH", 40)] },
        "COUNTER_PAYMENT_SHAPE_CONFLICT",
      ],
      ["neither payment nor payments", {}, "COUNTER_PAYMENT_SHAPE_CONFLICT"],
    ];

    it.each(cases.map(([name, body, code]) => ({ name, body, code })))(
      "$name -> 400 $code and nothing written",
      async ({ body, code }) => {
        const err = await errorOf(service.ring(walkInSale(body), staff, "key-1"));
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe(code);
        expect(written).toBe(false);
        expect(recordPayment).not.toHaveBeenCalled();
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
      },
    );

    it("a named customer's over-cover is refused before the sale too (server total, pre-credit)", async () => {
      const err = await errorOf(
        service.ring(named({ payments: [L("CARD", 50), L("CHECK", 30, "9")] }), staff),
      );
      expect(err.getResponse().code).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
      expect(written).toBe(false);
    });

    it("a one-leg card above the server total is refused before the sale as well", async () => {
      const err = await errorOf(service.ring(named({ payment: L("CARD", 99) }), staff));
      expect(err.getResponse().code).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
      expect(written).toBe(false);
    });
  });

  describe("post-commit over-cover: the balance moved under the clerk (test 3)", () => {
    beforeEach(() => {
      // send() auto-applied 50 of credit: the pre-tender balance is 20, below the 30 card leg
      invoices = [
        inv("inv-1", 70, 1, [
          { id: "cn-1", amount: 50, method: "CREDIT_NOTE", status: "PAID", paymentGroupId: null },
        ]),
      ];
    });

    it("201 + paymentRecorded:false + COUNTER_PAYMENT_EXCEEDS_TOTAL, and NOTHING is recorded (all or nothing)", async () => {
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 40 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
        paid: 50,
        balanceDue: 20,
      });
      expect(r.change).toBeUndefined();
    });

    it("the same refusal stands when credit covered the whole sale", async () => {
      invoices = [
        inv("inv-1", 70, 1, [
          { id: "cn-1", amount: 70, method: "CREDIT_NOTE", status: "PAID", paymentGroupId: null },
        ]),
      ];
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 40 },
          ],
        }),
        staff,
      );
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it("a cash leg that would place nothing is the same refusal (cash handed over against a covered balance)", async () => {
      invoices = [
        inv("inv-1", 70, 1, [
          { id: "cn-1", amount: 30, method: "CREDIT_NOTE", status: "PAID", paymentGroupId: null },
        ]),
      ];
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 40 },
            { method: "CASH", amount: 5 },
          ],
        }),
        staff,
      );
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
      expect(recordPayment).not.toHaveBeenCalled();
    });
  });

  describe("the old single payment is a one-leg alias (test 13)", () => {
    it("payment { CASH 100 } on 70 still works: one row, change 30, method CASH", async () => {
      const r = await service.ring(walkInSale({ payment: { method: "CASH", amount: 100 } }), staff);
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(recordPayment.mock.calls[0][1]).toMatchObject({ amount: 70, method: "CASH" });
      expect(recordPayment.mock.calls[0][2]).toEqual({ paymentGroupId: legGroupId("ord-1", 0) });
      expect(r).toMatchObject({ method: "CASH", paid: 70, change: 30, paymentRecorded: true });
    });

    it("a payments array of ONE leg is the same sale as the alias", async () => {
      const r = await service.ring(
        walkInSale({ payments: [{ method: "CASH", amount: 100 }] }),
        staff,
      );
      expect(r).toMatchObject({ method: "CASH", paid: 70, change: 30, paymentRecorded: true });
    });
  });
});
