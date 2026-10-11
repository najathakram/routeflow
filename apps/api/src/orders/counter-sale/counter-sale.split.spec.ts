// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load; mocked at the boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
// The shared Postgres advisory lock is a pass-through with the same contract (fn runs under the lock).
const mockLockCalls: Array<{ family: string; key: string }> = [];
const mockLockFailure: { error: Error | null } = { error: null };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLockCalls.push({ family: opts.family, key: opts.key });
    if (mockLockFailure.error) throw mockLockFailure.error;
    return { acquired: true, value: await fn() };
  },
}));

import { Test } from "@nestjs/testing";
import { LockTimeoutError } from "../../common/db-locks";
import type { FulfilmentCapability } from "@routeflow/types";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { legGroupId } from "./counter-tender-row";
import { assertCashRefundWithinCap } from "../../returns/cash-refund-cap";

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
  let replay: boolean;
  let createSale: jest.Mock;
  let recordPayment: jest.Mock;
  let walkIns: { getOrCreateWalkIn: jest.Mock };
  // Order.counterCashTendered as storage holds it: the tender writes it (CAS like the real updateMany), the read-back reads it.
  let storedTendered: unknown;

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
    mockLockFailure.error = null;
    prisma = createMockPrisma();
    invoices = [inv("inv-1", 70, 1)];
    written = false;
    replay = false;
    createSale = jest.fn(async (_dto: any, _u: any, sale: any) => {
      // create() answers a replay from its pre-check, before pricing: it never calls beforeWrite then.
      if (replay) sale?.onReplay?.({ id: "ord-1", counterSale: true });
      else await sale?.beforeWrite?.({ total: total() });
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
    storedTendered = null;
    prisma.order.findFirst.mockImplementation(async () => ({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterCashTendered: storedTendered,
    }));
    prisma.order.updateMany.mockImplementation(async ({ where, data }: any) => {
      if ("counterCashTendered" in where && storedTendered !== where.counterCashTendered) {
        return { count: 0 };
      }
      storedTendered = data.counterCashTendered;
      return { count: 1 };
    });
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
      expect(r.change).toBe(0); // all the cash handed over went in: Change 0, no balance gate
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
      // the tender was refused: ALL the cash goes back, so no "change" figure (it would read as part-kept)
      expect(r.change).toBeUndefined();
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

  describe("replay of a split under the same Idempotency-Key (tests 5, 6, 7, 9)", () => {
    const G0 = legGroupId("ord-1", 0);
    const G1 = legGroupId("ord-1", 1);
    const split = (card = 30, cash = 50) => [
      { method: "CARD", amount: card },
      { method: "CASH", amount: cash },
    ];
    const row = (id: string, amount: number, method: string, group: string | null): Pay => ({
      id,
      amount,
      method,
      status: "PAID",
      paymentGroupId: group,
    });

    it("card recorded, cash not: the replay records ONLY the cash leg, and the sale ends fully paid with change", async () => {
      invoices = [inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0)])];
      storedTendered = 50; // the first call stored the cash handed over BEFORE any money moved
      replay = true;
      const r = await service.ring(walkInSale({ payments: split() }), staff, "key-1");
      expect(recordPayment.mock.calls.map((c) => [c[1].method, c[1].amount, c[2]])).toEqual([
        ["CASH", 40, { paymentGroupId: G1 }],
      ]);
      expect(r).toMatchObject({
        replayed: true,
        paid: 70,
        balanceDue: 0,
        change: 10,
        paymentRecorded: true,
      });
    });

    it("the double-submit LOSER: its lock times out after the winner finished; storage shows the balance covered, so it reads RECORDED", async () => {
      invoices = [
        inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0), row("p1", 40, "CASH", G1)]),
      ];
      replay = true;
      mockLockFailure.error = new LockTimeoutError("counter-tender", "ord-1", 0);
      const r = await service.ring(walkInSale({ payments: split() }), staff, "key-1");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ replayed: true, paid: 70, balanceDue: 0, paymentRecorded: true });
      expect(r.paymentErrorCode).toBeUndefined();
    });

    it("a lock timeout with the balance STILL owing is not recorded (the split did not finish)", async () => {
      invoices = [inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0)])];
      replay = true;
      mockLockFailure.error = new LockTimeoutError("counter-tender", "ord-1", 0);
      const r = await service.ring(walkInSale({ payments: split() }), staff, "key-1");
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
        balanceDue: 40,
      });
    });

    it("a fully stored split replays with NO new row and the same answer", async () => {
      invoices = [
        inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0), row("p1", 40, "CASH", G1)]),
      ];
      replay = true;
      const r = await service.ring(walkInSale({ payments: split() }), staff, "key-1");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ replayed: true, paid: 70, change: 10, paymentRecorded: true });
    });

    it("a held pre-deploy attempt: a seeded UNGROUPED card row + the old {payment} replay -> no second charge", async () => {
      invoices = [inv("inv-1", 70, 1, [row("old", 70, "CREDIT_CARD", null)])];
      replay = true;
      const r = await service.ring(walkInSale({ payment: { method: "CARD" } }), staff, "key-1");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        replayed: true,
        paid: 70,
        balanceDue: 0,
        paymentRecorded: true,
        method: "CARD",
      });
    });

    it("a resumed CARD/CHECK leg is placed whole or not at all: an office payment that ate its room is 409, never a partial charge", async () => {
      // card 30 + check 20 + cash 20 on 70. Card was taken; the office then took 25 on the invoice (no group id):
      // only 15 of room is left for the 20 check leg. The old resume recorded a 15 check.
      invoices = [
        inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0), row("office", 25, "CASH", null)]),
      ];
      replay = true;
      const err = await errorOf(
        service.ring(
          walkInSale({
            payments: [
              { method: "CARD", amount: 30 },
              { method: "CHECK", amount: 20, reference: "1042" },
              { method: "CASH", amount: 20 },
            ],
          }),
          staff,
          "key-1",
        ),
      );
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse().code).toBe("COUNTER_TENDER_CHANGED");
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it("legacy partial then resume: a pre-split CASH 80 that died after inv1 resumes UNGROUPED, so the sale stays all-legacy", async () => {
      // mixed regulated sale: inv1 50 + inv2 20. The old code recorded inv1's 50 (no group id) and crashed.
      invoices = [inv("inv-1", 50, 1, [row("old", 50, "CASH", null)]), inv("inv-2", 20, 2)];
      replay = true;
      const r = await service.ring(
        walkInSale({ payment: { method: "CASH", amount: 80 } }),
        staff,
        "key-1",
      );
      // inv2's 20 is written WITHOUT a group id: a grouped row would make readStoredTender drop the legacy 50
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount, c[2]])).toEqual([
        ["inv-2", 20, undefined],
      ]);
      expect(r).toMatchObject({
        paid: 70,
        balanceDue: 0,
        change: 10,
        paymentRecorded: true,
        paymentId: "old",
      });
      expect(r.payments).toEqual([{ method: "CASH", amount: 70, paymentIds: ["old", "pay-1"] }]);
    });

    it("an interrupted leg resumes: only the (leg, invoice) pair with no row yet is recorded", async () => {
      // card 30 (inv-1) and cash 20 (inv-1) were taken; cash's 20 on inv-2 is the missing pair
      invoices = [
        inv("inv-1", 50, 1, [row("p0", 30, "CREDIT_CARD", G0), row("p1", 20, "CASH", G1)]),
        inv("inv-2", 20, 2),
      ];
      storedTendered = 50;
      replay = true;
      await service.ring(walkInSale({ payments: split() }), staff, "key-1");
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].method, c[1].amount])).toEqual([
        ["inv-2", "CASH", 20],
      ]);
    });

    describe("COUNTER_TENDER_CHANGED (409) leaves everything as it was", () => {
      const refused = async (body: any) => {
        replay = true;
        const err = await errorOf(service.ring(walkInSale(body), staff, "key-1"));
        expect(err.getStatus()).toBe(409);
        expect(err.getResponse().code).toBe("COUNTER_TENDER_CHANGED");
        expect(recordPayment).not.toHaveBeenCalled();
      };

      it("a split meeting a pre-split attempt's ungrouped rows", async () => {
        invoices = [inv("inv-1", 70, 1, [row("old", 30, "CREDIT_CARD", null)])];
        await refused({ payments: split() });
      });

      it("leg 0's method differs from the stored one (ungrouped and grouped)", async () => {
        invoices = [inv("inv-1", 70, 1, [row("old", 70, "CREDIT_CARD", null)])];
        await refused({ payment: { method: "CASH" } });
        invoices = [inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0)])];
        await refused({
          payments: [
            { method: "CHECK", amount: 30, reference: "1" },
            { method: "CASH", amount: 40 },
          ],
        });
      });

      it("a stored later leg has a different method", async () => {
        invoices = [
          inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0), row("p1", 40, "CHECK", G1)]),
        ];
        await refused({ payments: split() });
      });

      it("a stored leg index at or beyond the request's leg count", async () => {
        invoices = [
          inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0), row("p1", 40, "CASH", G1)]),
        ];
        await refused({ payment: { method: "CARD", amount: 30 } });
      });

      it("a stored leg sum above its planned placement (a smaller card amount this time)", async () => {
        invoices = [inv("inv-1", 70, 1, [row("p0", 30, "CREDIT_CARD", G0)])];
        await refused({ payments: split(20, 50) });
      });

      it("an amount above the plan on one invoice is never topped up on another", async () => {
        invoices = [inv("inv-1", 50, 1), inv("inv-2", 20, 2)];
        invoices[1].payments = [row("p0", 20, "CREDIT_CARD", G0)]; // leg 0 planned 30 on inv-1, 0 on inv-2
        await refused({ payments: split() });
      });
    });

    it("rows with no group id of this sale (an office payment later) are not part of a grouped replay", async () => {
      invoices = [
        inv("inv-1", 100, 1, [row("p0", 30, "CREDIT_CARD", G0), row("office", 20, "CASH", null)]),
      ];
      storedTendered = 70; // the first call asked for card 30 + cash 70 and stored the cash handed over
      replay = true;
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 70 },
          ],
        }),
        staff,
        "key-1",
      );
      // office's 20 never counts as leg 1's cash: the cash leg's 70 is recorded, capped by capacity (50)
      expect(recordPayment.mock.calls.map((c) => [c[1].method, c[2]])).toEqual([
        ["CASH", { paymentGroupId: G1 }],
      ]);
    });
  });

  describe("invoices are read oldest first with a total order (test 9)", () => {
    it("readInvoices orders by createdAt then id", async () => {
      await service.ring(walkInSale({ payments: [{ method: "CASH", amount: 70 }] }), staff);
      const reads = prisma.invoice.findMany.mock.calls.map((c: any[]) => c[0]);
      expect(reads.length).toBeGreaterThan(0);
      for (const r of reads) expect(r.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    });

    it("two invoices created in the same instant are tendered in id order, whatever order storage hands them back", async () => {
      // storage ignores ORDER BY in this mock: emulate the database honouring the requested order
      const same = new Date(2026, 9, 4, 12, 0, 0);
      const b = { ...inv("inv-b", 20, 1), createdAt: same };
      const a = { ...inv("inv-a", 50, 1), createdAt: same };
      invoices = [b, a];
      prisma.invoice.findMany.mockImplementation(async ({ orderBy }: any) => {
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(
          (o: any) => Object.keys(o)[0],
        );
        const sorted = [...invoices].sort((x: any, y: any) => {
          for (const k of keys) {
            const d = x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0;
            if (d) return d;
          }
          return 0;
        });
        return sorted.map((i) => ({ ...i, payments: [...i.payments] }));
      });
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
      );
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([
        ["inv-a", 30],
        ["inv-a", 20],
        ["inv-b", 20],
      ]);
    });
  });

  describe("response: per-leg payments[] and change, POST and GET by-key (tests 10, web contract 2-3)", () => {
    const body = [
      { method: "CARD", amount: 30, reference: "auth-1" },
      { method: "CASH", amount: 50 },
    ];
    const SALE = {
      id: "ord-1",
      orderNumber: "ORD-1",
      fulfillPath: "PICKUP",
      skipAutoMerge: true,
      counterSale: true,
      status: "DELIVERED",
      customerId: "cust-walkin",
    };

    it("POST card 30 + cash 50 on a 70 sale: the exact JSON (top-level method/paymentId are leg 0; amounts are RECORDED)", async () => {
      const r = await service.ring(walkInSale({ payments: body }), staff, "key-1");
      expect(r).toEqual({
        orderId: "ord-1",
        orderNumber: "ORD-1",
        invoiceId: "inv-1",
        invoiceNumber: "N-inv-1",
        total: 70,
        paid: 70,
        balanceDue: 0,
        change: 10,
        cashTendered: 50,
        lines: [],
        paymentId: "pay-1",
        payments: [
          { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
          { method: "CASH", amount: 40, paymentIds: ["pay-2"] },
        ],
        method: "CARD",
        paymentRecorded: true,
      });
    });

    it("a replay of the same split answers the identical body (+ replayed:true), change included", async () => {
      const first = await service.ring(walkInSale({ payments: body }), staff, "key-1");
      replay = true;
      const again = await service.ring(walkInSale({ payments: body }), staff, "key-1");
      expect(again).toEqual({ ...first, replayed: true });
    });

    it("a split across two invoices: each leg's rows are listed under that leg", async () => {
      invoices = [inv("inv-1", 50, 1), inv("inv-2", 20, 2)];
      const r = await service.ring(walkInSale({ payments: body }), staff);
      expect(r.payments).toEqual([
        { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
        { method: "CASH", amount: 40, paymentIds: ["pay-2", "pay-3"] },
      ]);
      expect(r.paymentId).toBe("pay-1");
    });

    it("GET by-key (the screen's ?method=<leg 0 method>) returns the grouped legs of a split sale, not just leg 0", async () => {
      await service.ring(walkInSale({ payments: body }), staff, "key-1");
      (service as any).orders.findReplayCandidateByKey.mockResolvedValue(SALE);
      const r = await service.byKey("key-1", "CARD");
      expect(r).toMatchObject({
        method: "CARD",
        paymentId: "pay-1",
        paid: 70,
        balanceDue: 0,
        paymentRecorded: true,
        replayed: true,
        payments: [
          { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
          { method: "CASH", amount: 40, paymentIds: ["pay-2"] },
        ],
      });
      // cash handed over is not stored: by-key never invents a change figure
      expect(r.change).toBeUndefined();
    });

    it("GET by-key with a ?method that is not leg 0's still lists the STORED legs under their stored methods", async () => {
      await service.ring(walkInSale({ payments: body }), staff, "key-1");
      (service as any).orders.findReplayCandidateByKey.mockResolvedValue(SALE);
      const stored = [
        { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
        { method: "CASH", amount: 40, paymentIds: ["pay-2"] },
      ];
      // ON_ACCOUNT used to make leg 0 vanish (card money missing); CASH used to relabel the stored card leg
      expect((await service.byKey("key-1", "ON_ACCOUNT")).payments).toEqual(stored);
      expect((await service.byKey("key-1", "CASH")).payments).toEqual(stored);
      expect((await service.byKey("key-1", "CHECK")).payments).toEqual(stored);
    });

    it("GET by-key without ?method derives every leg and leg 0's method from storage", async () => {
      await service.ring(walkInSale({ payments: body }), staff, "key-1");
      (service as any).orders.findReplayCandidateByKey.mockResolvedValue(SALE);
      const r = await service.byKey("key-1");
      expect(r.method).toBe("CARD");
      expect(r.payments).toEqual([
        { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
        { method: "CASH", amount: 40, paymentIds: ["pay-2"] },
      ]);
    });

    it("change is present when card is leg 0 and cash is leg 1 (today it needed the TOP-LEVEL method to be CASH)", async () => {
      const r = await service.ring(walkInSale({ payments: body }), staff);
      expect(r.method).toBe("CARD");
      expect(r.change).toBe(10);
    });

    it("an office CASH payment on the same invoice is not the cash leg's: it is not listed under the leg and not in the change", async () => {
      // 100 sale: card 30 + cash 50 handed over were taken (balance 20 on account); the office then took 20 cash on the
      // invoice (no group id). The same body replays: no write, the leg lists only its own row, and the office's
      // cash is not the leg's (counting it would read 70 paid in cash).
      invoices = [
        inv("inv-1", 100, 1, [
          {
            id: "p0",
            amount: 30,
            method: "CREDIT_CARD",
            status: "PAID",
            paymentGroupId: legGroupId("ord-1", 0),
          },
          {
            id: "p1",
            amount: 50,
            method: "CASH",
            status: "PAID",
            paymentGroupId: legGroupId("ord-1", 1),
          },
          { id: "office", amount: 20, method: "CASH", status: "PAID", paymentGroupId: null },
        ]),
      ];
      storedTendered = 50;
      replay = true;
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ paid: 100, balanceDue: 0, change: 0, paymentRecorded: true });
      expect(r.payments).toEqual([
        { method: "CARD", amount: 30, paymentIds: ["p0"] },
        { method: "CASH", amount: 50, paymentIds: ["p1"] },
      ]);
    });

    it("no change while the stored balance is not covered (a named customer's part-pay)", async () => {
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 10 },
          ],
        }),
        staff,
      );
      expect(r.change).toBe(0); // the 10 handed over all went in: Change 0, no balance gate
      expect(r.payments).toEqual([
        { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
        { method: "CASH", amount: 10, paymentIds: ["pay-2"] },
      ]);
    });

    it("a refused split still names its legs, each with amount 0 and no rows", async () => {
      invoices = [
        inv("inv-1", 70, 1, [
          { id: "cn-1", amount: 50, method: "CREDIT_NOTE", status: "PAID", paymentGroupId: null },
        ]),
      ];
      const r = await service.ring(named({ payments: body }), staff);
      expect(r.payments).toEqual([
        { method: "CARD", amount: 0, paymentIds: [] },
        { method: "CASH", amount: 0, paymentIds: [] },
      ]);
      expect(r.paymentId).toBeUndefined();
    });

    it("ON_ACCOUNT is not a tender: no payments line", async () => {
      const r = await service.ring(named({ payment: { method: "ON_ACCOUNT" } }), staff);
      expect(r.payments).toBeUndefined();
      expect(r.method).toBe("ON_ACCOUNT");
    });
  });

  describe("the split's rows feed the ONE cash-refund cap (test 11, SA-740r2's assertCashRefundWithinCap)", () => {
    /** The cap's own payment read, answered from the ledger this sale actually wrote. */
    const capTx = (earlier: Array<{ orderId: string; refundAmount: number }> = []) => ({
      invoicePayment: {
        findMany: jest.fn(async (args: any) =>
          invoices
            .filter((i) => !["VOID", "WRITTEN_OFF"].includes(i.status))
            .flatMap((i) =>
              i.payments
                .filter((p) => p.method === args.where.method && p.status === args.where.status)
                .map((p) => ({ amount: p.amount, invoice: { orderId: "ord-1" } })),
            ),
        ),
      },
      returnItem: { findMany: jest.fn(async () => []) },
      return: { findMany: jest.fn(async () => earlier) },
    });
    const cashRefund = (
      amount: number,
      earlier?: Array<{ orderId: string; refundAmount: number }>,
    ) =>
      assertCashRefundWithinCap(capTx(earlier), {
        returnId: "ret-now",
        tender: "CASH",
        perOrder: new Map([["ord-1", amount]]),
      }).then(
        () => null,
        (e: any) => ({ status: e.getStatus(), code: e.getResponse().code }),
      );

    beforeEach(async () => {
      // card 30 + cash 50 on a 70 sale: the cash row is 40 (change 10 is not stored), the card row is not cash
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
      );
    });

    it("cash applied is the cash LEG's placed 40, never the 50 handed over nor the card's 30", async () => {
      expect(await cashRefund(40)).toBeNull();
      expect(await cashRefund(40.01)).toEqual({ status: 409, code: "REFUND_EXCEEDS_CASH_PAID" });
    });

    it("earlier refunds on the sale reduce the room: 40 cash, 20 refunded -> 20 fits, 20.01 is 409", async () => {
      const earlier = [{ orderId: "ord-1", refundAmount: 20 }];
      expect(await cashRefund(20, earlier)).toBeNull();
      expect(await cashRefund(20.01, earlier)).toEqual({
        status: 409,
        code: "REFUND_EXCEEDS_CASH_PAID",
      });
    });

    it("a sale with no cash leg (card 30 + check 40) has no cash room at all", async () => {
      invoices = [inv("inv-1", 70, 1)];
      recordPayment.mockClear();
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CHECK", amount: 40, reference: "1042" },
          ],
        }),
        staff,
        "key-2",
      );
      expect(await cashRefund(0.01)).toEqual({ status: 409, code: "REFUND_EXCEEDS_CASH_PAID" });
    });
  });
  // SA-749r2 (round 2): Order.counterCashTendered is the cash LEG's handed-over amount at any index, and every
  // surface serves change from it through pricing's counterChange (no first-tender gate).
  describe("the cash handed over and the one change figure", () => {
    const tenderedWrites = () => prisma.order.updateMany.mock.calls.map((c: any[]) => c[0]);

    it("card 30 + cash handed 40 on a 50 total: tendered 40 stored, change 20, the cash row applies 20", async () => {
      invoices = [inv("inv-1", 50, 1)];
      const r = await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 40 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(storedTendered).toBe(40);
      expect(r).toMatchObject({ paid: 50, balanceDue: 0, cashTendered: 40, change: 20 });
      // the till and the day close count the APPLIED cash (the payment row), never the handed-over amount
      expect(r.payments).toEqual([
        { method: "CARD", amount: 30, paymentIds: ["pay-1"] },
        { method: "CASH", amount: 20, paymentIds: ["pay-2"] },
      ]);
      expect(recordPayment.mock.calls.map((c) => [c[1].method, c[1].amount])).toEqual([
        ["CREDIT_CARD", 30],
        ["CASH", 20],
      ]);
    });

    it("card 60 on a 50 total is refused BEFORE any write: COUNTER_PAYMENT_EXCEEDS_TOTAL, no order row, nothing stored", async () => {
      invoices = [inv("inv-1", 50, 1)];
      const e = await errorOf(
        service.ring(walkInSale({ payments: [{ method: "CARD", amount: 60 }] }), staff, "key-1"),
      );
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_PAYMENT_EXCEEDS_TOTAL" });
      expect(written).toBe(false);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(tenderedWrites()).toEqual([]);
    });

    it("card-first $70: card 30 + cash handed 50: change 10 on the 201 and on the by-key readback", async () => {
      const r = await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(r).toMatchObject({ method: "CARD", cashTendered: 50, change: 10 });
      (service as any).orders.findReplayCandidateByKey.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        counterSale: true,
        status: "DELIVERED",
        counterCashTendered: storedTendered,
      });
      const k = await service.byKey("key-1");
      expect(k).toMatchObject({ method: "CARD", cashTendered: 50, change: 10 });
    });

    it("cash-first $70: cash handed 50 then card 30: the server still applies card first, change 10", async () => {
      const r = await service.ring(
        walkInSale({
          payments: [
            { method: "CASH", amount: 50 },
            { method: "CARD", amount: 30 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(r).toMatchObject({ method: "CASH", cashTendered: 50, change: 10 });
      expect(r.payments?.map((p) => p.method)).toEqual(["CASH", "CARD"]);
      expect(recordPayment.mock.calls.map((c) => c[1].method)).toEqual(["CREDIT_CARD", "CASH"]);
    });

    it("the handed-over amount is written once: a replay of a stored cash leg never overwrites it", async () => {
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
      replay = true;
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
      expect(storedTendered).toBe(50);
      // the anchored replay can only FILL a null (CAS on counterCashTendered: null)
      const last = tenderedWrites().at(-1);
      expect(last.where).toEqual({ id: "ord-1", counterCashTendered: null });
    });

    it("S1 by-key reads the stored cash row's change: a card payment voided later does not move it (20)", async () => {
      invoices = [inv("inv-1", 50, 1)];
      await service.ring(
        walkInSale({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 40 },
          ],
        }),
        staff,
        "key-1",
      );
      invoices[0].payments.find((p) => p.method === "CREDIT_CARD")!.status = "VOID";
      (service as any).orders.findReplayCandidateByKey.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        counterSale: true,
        status: "DELIVERED",
        counterCashTendered: storedTendered,
      });
      expect(await service.byKey("key-1")).toMatchObject({ cashTendered: 40, change: 20 });
    });

    it("N5 a replay with a DIFFERENT cash amount (100) is 409 and keeps the first stored tendered (50)", async () => {
      const legs = (cash: number) => [
        { method: "CARD", amount: 30 },
        { method: "CASH", amount: cash },
      ];
      await service.ring(walkInSale({ payments: legs(50) }), staff, "key-1");
      expect(storedTendered).toBe(50);
      const writesBefore = recordPayment.mock.calls.length;
      replay = true;
      const e = await errorOf(service.ring(walkInSale({ payments: legs(100) }), staff, "key-1"));
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_TENDER_CHANGED" });
      expect(storedTendered).toBe(50);
      expect(recordPayment).toHaveBeenCalledTimes(writesBefore);
    });

    it("a card-only sale stores no tendered and serves no change", async () => {
      const r = await service.ring(
        walkInSale({ payments: [{ method: "CARD", amount: 70 }] }),
        staff,
        "key-1",
      );
      expect(storedTendered).toBeNull();
      expect(tenderedWrites()).toEqual([]);
      expect(r.change).toBeUndefined();
      expect(r.cashTendered).toBeUndefined();
    });
  });
  // S2 (Lead ruling): a replay under the same Idempotency-Key must be the SAME tender. Any difference is 409
  // COUNTER_TENDER_CHANGED with nothing written, so a finished part-pay sale is never topped up by a different body.
  describe("a replay with a different tender is refused (S2)", () => {
    const storedSale = (payments: Pay[], tendered: number | null) => {
      invoices = [inv("inv-1", 50, 1, payments)];
      storedTendered = tendered;
      replay = true;
    };
    const card30 = () => ({
      id: "p0",
      amount: 30,
      method: "CREDIT_CARD",
      status: "PAID",
      paymentGroupId: legGroupId("ord-1", 0),
    });
    const cash = (amount: number) => ({
      id: "p1",
      amount,
      method: "CASH",
      status: "PAID",
      paymentGroupId: legGroupId("ord-1", 1),
    });
    const refused = async (body: any) => {
      const e = await errorOf(service.ring(named(body), staff, "key-1"));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_TENDER_CHANGED" });
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    };

    it("stored Card 30 + Cash 15 on 50 (part-pay, finished), replayed with Cash 20: 409, nothing written", async () => {
      storedSale([card30(), cash(15)], 15);
      await refused({
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 20 },
        ],
      });
    });

    it("stored Card 30 on 50, replayed with Card 35: 409, nothing written", async () => {
      storedSale([card30()], null);
      await refused({ payments: [{ method: "CARD", amount: 35 }] });
    });

    it("stored Card 30 + Cash 15, replayed with Cash 25 (placed 20 here, not 15): 409", async () => {
      storedSale([card30(), cash(15)], 15);
      // cash 25 is placed as min(25, 20 left) = 20 here, a different placement than the stored 15
      await refused({
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 25 },
        ],
      });
    });

    it("stored Card 30 + Cash 50 (20 placed, 50 handed), replayed with Cash 60 (still 20 placed): 409 on the handed amount", async () => {
      storedSale([card30(), cash(20)], 50);
      await refused({
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 60 },
        ],
      });
    });

    it("the SAME legs replay serves the stored sale and writes nothing", async () => {
      storedSale([card30(), cash(15)], 15);
      const r = await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 15 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ replayed: true, paid: 45, balanceDue: 5, cashTendered: 15 });
    });

    it("a held single `payment` and the equivalent one-leg `payments` fingerprint alike (both replay the stored sale)", async () => {
      storedSale([{ ...card30(), amount: 30 }], null);
      const alias = await service.ring(
        named({ payment: { method: "CARD", amount: 30 } }),
        staff,
        "key-1",
      );
      const array = await service.ring(
        named({ payments: [{ method: "CARD", amount: 30 }] }),
        staff,
        "key-1",
      );
      expect(recordPayment).not.toHaveBeenCalled();
      expect(array).toEqual(alias);
    });

    it("an interrupted split still resumes ONLY when the stored legs are the request's (card stored, cash missing)", async () => {
      storedSale([card30()], 50);
      invoices[0].total = 70;
      await service.ring(
        named({
          payments: [
            { method: "CARD", amount: 30 },
            { method: "CASH", amount: 50 },
          ],
        }),
        staff,
        "key-1",
      );
      expect(recordPayment.mock.calls.map((c) => [c[1].method, c[1].amount])).toEqual([
        ["CASH", 40],
      ]);
    });

    it("a replay that ADDS a cash leg to a sale taken without one is 409 (no tendered was ever stored)", async () => {
      storedSale([card30()], null);
      await refused({
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 20 },
        ],
      });
    });

    it("a replay that DROPS the cash leg of a sale that took one is 409", async () => {
      storedSale([card30()], 50);
      await refused({ payments: [{ method: "CARD", amount: 30 }] });
    });

    it("the legs in another ORDER are another request: leg indexes are the stored identity, so 409", async () => {
      storedSale([card30(), cash(20)], 20);
      await refused({
        payments: [
          { method: "CASH", amount: 20 },
          { method: "CARD", amount: 30 },
        ],
      });
    });
  });
});
