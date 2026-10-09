/**
 * SA-740r/r2 (R20-2): a STANDARD return resolved as a recorded cash/card/check refund (`processRefund` with method
 * EXTERNAL_REFUND) needs its order's creditable invoices PAID IN FULL, the same rule and the same code as the inline
 * refund (409 REFUND_NEEDS_PAID_INVOICE), via ONE resolver + ONE predicate (`resolveRefundInvoiceIds` +
 * `sourcesAreRefundable`). VOID / WRITTEN_OFF invoices are not part of the set; zero creditable invoices is a 409; paid with
 * store credit is store credit only (F4). The check runs under the Return, Order and Invoice locks in the SAME transaction as
 * the claim, which also carries the optional tender (`Return.refundTender`, CARD is CREDIT_CARD). Before this the B53 escape
 * hatch resolved an EXTERNAL_REFUND on a VOID-only or partly paid order (200 REFUNDED).
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

type Pay = { amount: number; status: string; method: string };
type Inv = { id: string; status: string; total: number; payments: Pay[] };

const paidCash = (total: number): Pay[] => [{ amount: total, status: "PAID", method: "CASH" }];

describe("ReturnsService.processRefund EXTERNAL_REFUND: paid-in-full, locked, tender (SA-740r2)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;
  let raw: Array<{ text: string; values: unknown[] }>;
  let invoices: Inv[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn();
    raw = [];
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          raw.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
          return Promise.resolve(0);
        }),
      }),
    );
    invoices = [{ id: "inv-1", status: "SENT", total: 100, payments: paidCash(100) }];
    // the resolver (by order) and the state reader (by ids) both read invoices; honour both where shapes
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.id?.in) return invoices.filter((i) => where.id.in.includes(i.id));
      const notIn: string[] = where?.status?.notIn ?? [];
      return invoices.filter((i) => !notIn.includes(i.status)).map((i) => ({ id: i.id }));
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.findFirst.mockResolvedValue({ id: "ret-1", status: "RECEIVED" });
    // SA-749r2 item 9: the cash applied to the order (the cap reads it under the locks): $100 in cash on ord-1
    prisma.invoicePayment.findMany.mockResolvedValue([
      { amount: 100, invoice: { orderId: "ord-1" } },
    ]);
    const mod = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  /** A RECEIVED STANDARD return of 2 of product p1 on an order whose invoice lines carry the price. */
  function setReturn(
    over: { counterSale?: boolean; registerKey?: string | null; invoiceStatus?: string } = {},
  ) {
    prisma.return.findUnique.mockImplementation(async (args: any) => {
      if (args?.include?.order) {
        return {
          id: "ret-1",
          returnNumber: "RET-1",
          status: "RECEIVED",
          kind: "STANDARD",
          customerId: "cust-1",
          orderId: "ord-1",
          items: [{ productId: "p1", qty: 2 }],
          order: {
            id: "ord-1",
            orderNumber: "ORD-1",
            counterSale: over.counterSale ?? false,
            registerKey: over.registerKey ?? null,
            invoices: [
              {
                id: "inv-1",
                invoiceNumber: "INV-1",
                status: over.invoiceStatus ?? "SENT",
                total: 100,
                items: [{ productId: "p1", qty: 10, subtotal: 100 }],
              },
            ],
            lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
          },
        };
      }
      return { id: "ret-1", status: "REFUNDED", refundMethod: "EXTERNAL_REFUND", refundAmount: 20 };
    });
  }

  const codeOf = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => e?.getResponse?.()?.code ?? e?.constructor?.name ?? null,
    );
  const refund = (dto: Record<string, unknown> = {}) =>
    service.processRefund("ret-1", { method: "EXTERNAL_REFUND", ...dto } as any);

  it("paid in full: records the refund inside ONE transaction (the claim carries refundedAt and the amount)", async () => {
    setReturn();
    await expect(refund()).resolves.toBeDefined();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-1", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 20,
        refundedAt: expect.any(Date),
        refundTender: null, // no tender sent: unknown (tenderKnown false)
      },
    });
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  describe("R20-2: 409 REFUND_NEEDS_PAID_INVOICE, nothing written", () => {
    it.each([
      [
        "a VOID-only order (the B53 escape hatch)",
        [{ id: "inv-1", status: "VOID", total: 100, payments: paidCash(100) }],
      ],
      [
        "a WRITTEN_OFF-only order",
        [{ id: "inv-1", status: "WRITTEN_OFF", total: 100, payments: [] }],
      ],
      ["an unpaid invoice", [{ id: "inv-1", status: "SENT", total: 100, payments: [] }]],
      [
        "a partly paid invoice",
        [{ id: "inv-1", status: "PARTIAL", total: 100, payments: paidCash(40) }],
      ],
      [
        "only a PENDING payment",
        [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            payments: [{ amount: 100, status: "PENDING", method: "CHECK" }],
          },
        ],
      ],
      ["an order with no invoice at all", []],
    ] as Array<[string, Inv[]]>)("%s", async (_label, set) => {
      invoices = set;
      setReturn({ invoiceStatus: set[0]?.status });
      expect(await codeOf(refund())).toBe("REFUND_NEEDS_PAID_INVOICE");
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("the 409 tells the operator the exits: store credit when billable, else cancel the return (never 'outside RouteFlow')", async () => {
      invoices = [{ id: "inv-1", status: "VOID", total: 100, payments: [] }];
      setReturn({ invoiceStatus: "VOID" });
      const err: any = await refund().catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      const message: string = err.getResponse().message;
      expect(message).toMatch(/store credit/i);
      expect(message).toMatch(/cancel the return/i);
      expect(message).not.toMatch(/outside RouteFlow/i);
    });
  });

  it("a VOID invoice beside a paid one is not part of the set: the paid one decides", async () => {
    invoices = [
      { id: "inv-void", status: "VOID", total: 100, payments: [] },
      { id: "inv-1", status: "PAID", total: 100, payments: paidCash(100) },
    ];
    setReturn();
    await expect(refund()).resolves.toBeDefined();
  });

  it("F4: paid with store credit means store credit only: 409 REFUND_PAID_WITH_STORE_CREDIT", async () => {
    invoices = [
      {
        id: "inv-1",
        status: "PAID",
        total: 100,
        payments: [{ amount: 100, status: "PAID", method: "CREDIT_NOTE" }],
      },
    ];
    setReturn();
    expect(await codeOf(refund())).toBe("REFUND_PAID_WITH_STORE_CREDIT");
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("the CREDIT_NOTE (store credit) path is untouched by the paid-in-full rule", async () => {
    invoices = [{ id: "inv-1", status: "SENT", total: 100, payments: [] }];
    setReturn({ invoiceStatus: "SENT" });
    creditNotesCreate.mockResolvedValue({ id: "cn-1" });
    await expect(
      service.processRefund("ret-1", { method: "CREDIT_NOTE" } as any),
    ).resolves.toBeDefined();
    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
  });

  describe("the tender", () => {
    it.each([
      ["CASH", "CASH"],
      ["CARD", "CREDIT_CARD"],
      ["CHECK", "CHECK"],
    ])("%s is written in the claim as %s", async (tender, column) => {
      setReturn();
      await refund({ tender });
      expect(prisma.return.updateMany.mock.calls[0][0].data.refundTender).toBe(column);
    });
  });

  describe("SA-749r2 item 9: the cash cap applies to the STANDARD refund too", () => {
    it("a CASH refund above the cash applied to the order (less earlier cash refunds) is 409 REFUND_EXCEEDS_CASH_PAID", async () => {
      setReturn();
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 15, invoice: { orderId: "ord-1" } },
      ]);
      const err: any = await refund({ tender: "CASH" }).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 15,
        requested: 20,
      });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("an earlier cash refund of the order (unknown tender counts as cash) reduces the room", async () => {
      setReturn();
      prisma.return.findMany.mockResolvedValue([{ orderId: "ord-1", refundAmount: 90 }]);
      expect((await refund({ tender: "CASH" }).catch((e) => e)).getResponse()).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 10,
      });
    });

    it("CARD, CHECK and an omitted tender are not capped", async () => {
      setReturn();
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      for (const dto of [{ tender: "CARD" }, { tender: "CHECK" }, {}]) {
        prisma.return.updateMany.mockClear();
        await expect(refund(dto)).resolves.toBeDefined();
      }
    });
  });

  describe("a tender belongs to a recorded refund only; a tenantless session is refused", () => {
    it.each([{ method: "CREDIT_NOTE", tender: "CASH" }, { tender: "CARD" }])(
      "store credit with a tender is a 400 before anything is read or written (%j)",
      async (dto) => {
        setReturn();
        const err: any = await service.processRefund("ret-1", dto as any).catch((e) => e);
        expect(err.getStatus()).toBe(400);
        expect(err.message).toMatch(/tender/i);
        expect(prisma.return.findUnique).not.toHaveBeenCalled();
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
        expect(creditNotesCreate).not.toHaveBeenCalled();
      },
    );

    it("row 59: a tenantless session is 403 REFUND_NOT_ALLOWED before any read", async () => {
      prisma.getTenantId.mockReturnValue(null);
      setReturn();
      expect(await codeOf(refund())).toBe("REFUND_NOT_ALLOWED");
      expect(prisma.return.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("SA-740r2 item 6: a counter order's refund takes the shared counter-close lock FIRST", () => {
    it("counter order: counter-close (tenant:register), then Return, Order, Invoices", async () => {
      setReturn({ counterSale: true, registerKey: null });
      await refund();
      expect(raw[0].text).toBe(
        "SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext(?))",
      );
      expect(raw[0].values).toEqual(["test-tenant:main"]);
      expect(raw).toHaveLength(4);
      expect(raw[1].text).toMatch(/FROM "Return" WHERE id/);
    });

    it("a named register is keyed tenant:register; refundedAt is set after the lock (the claim is the last write)", async () => {
      setReturn({ counterSale: true, registerKey: "till-2" });
      await refund();
      expect(raw[0].values).toEqual(["test-tenant:till-2"]);
      expect(prisma.return.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(0);
    });
  });

  describe("lock order inside the claim's transaction", () => {
    it("Return, then the order, then the order's creditable invoices; the paid-in-full read follows the invoice lock", async () => {
      setReturn();
      await refund();
      expect(raw.map((r) => r.text)).toEqual([
        expect.stringMatching(/FROM "Return" WHERE id = \? AND .* FOR UPDATE/),
        expect.stringMatching(/FROM "Order" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/),
        expect.stringMatching(/FROM "Invoice" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/),
      ]);
    });
  });
});
