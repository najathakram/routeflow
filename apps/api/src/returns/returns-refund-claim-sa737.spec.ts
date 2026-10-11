/**
 * SA-737: the STANDARD `processRefund` claim is ONE transaction for both methods, in the house lock order
 * (Return -> Order -> the order's creditable invoices, id-sorted), and the refund basis is RECOMPUTED inside it from the locked
 * rows. A void or an order cancel that committed between the first read and the lock changes what is billed; the claim never
 * runs from the first figure. The store-credit mint stays OUTSIDE the claim transaction (it opens its own).
 *
 * Mocked here (the lock order, the CAS shape, the sequencing). The real-Postgres interleavings are in
 * returns-refund-claim-sa737.db.spec.ts.
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
type Inv = { id: string; status: string; total: number; payments: Pay[]; lineSubtotal?: number };

const paidCash = (total: number): Pay[] => [{ amount: total, status: "PAID", method: "CASH" }];

describe("ReturnsService.processRefund: the locked claim with a basis recomputed under the lock (SA-737)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;
  let raw: string[];
  let inClaimTx: boolean;
  let createdInsideTx: boolean;
  /** What the order looks like at the FIRST read (before any lock) and at the read under the locks. */
  let before: Inv[];
  let after: Inv[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn();
    raw = [];
    inClaimTx = false;
    createdInsideTx = false;
    creditNotesCreate.mockImplementation(async () => {
      if (inClaimTx) createdInsideTx = true;
      return { id: "cn-1" };
    });
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      inClaimTx = true;
      try {
        return await fn({
          ...prisma,
          $executeRaw: jest.fn((strings: TemplateStringsArray) => {
            raw.push(strings.join("?").replace(/\s+/g, " ").trim());
            return Promise.resolve(0);
          }),
        });
      } finally {
        inClaimTx = false;
      }
    });
    before = [{ id: "inv-1", status: "SENT", total: 100, payments: paidCash(100) }];
    after = before;
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) => {
      const invs = inClaimTx ? after : before; // inside the claim tx the locked rows are the `after` rows
      if (where?.id?.in) return invs.filter((i) => where.id.in.includes(i.id));
      const notIn: string[] = where?.status?.notIn ?? [];
      return invs.filter((i) => !notIn.includes(i.status)).map((i) => ({ id: i.id }));
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({});
    prisma.return.findFirst.mockResolvedValue({
      id: "ret-1",
      status: "RECEIVED",
      kind: "STANDARD",
    });
    prisma.invoicePayment.findMany.mockResolvedValue([
      { amount: 100, invoice: { orderId: "ord-1" } },
    ]);
    // the first include-read is the pre-lock read; every later one is the read under the locks
    let includeReads = 0;
    prisma.return.findUnique.mockImplementation(async (args: any) => {
      if (args?.include?.order) {
        includeReads += 1;
        const invs = includeReads === 1 ? before : after;
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
            counterSale: false,
            registerKey: null,
            invoices: invs.map((i) => ({
              id: i.id,
              invoiceNumber: `N-${i.id}`,
              status: i.status,
              total: i.total,
              items: [{ productId: "p1", qty: 10, subtotal: i.lineSubtotal ?? 100 }],
            })),
            lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
          },
        };
      }
      return { id: "ret-1", status: "REFUNDED", refundAmount: 20, refundTender: null };
    });
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

  const refund = (method: "CREDIT_NOTE" | "EXTERNAL_REFUND") =>
    service.processRefund("ret-1", { method } as any);
  const failure = async (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => null,
      (e: any) => e,
    );
  const codeOf = (e: any) => e?.getResponse?.()?.code ?? null;

  describe("both methods claim inside ONE transaction, Return -> Order -> invoices", () => {
    it.each(["CREDIT_NOTE", "EXTERNAL_REFUND"] as const)(
      "%s: lock statements in house order",
      async (method) => {
        await refund(method);
        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        const order = raw.filter((t) => /FOR UPDATE/.test(t));
        expect(order).toEqual([
          expect.stringMatching(/FROM "Return" WHERE id = \? AND .* FOR UPDATE/),
          expect.stringMatching(/FROM "Order" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/),
          expect.stringMatching(/FROM "Invoice" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/),
        ]);
      },
    );

    it("the CAS names every column that proves the return is unresolved", async () => {
      await refund("CREDIT_NOTE");
      expect(prisma.return.updateMany.mock.calls[0][0].where).toEqual({
        id: "ret-1",
        status: "RECEIVED",
        refundedAt: null,
        creditNoteId: null,
      });
      expect(prisma.return.updateMany.mock.calls[0][0].data).toMatchObject({
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 20,
      });
    });

    it("a CAS that matches nothing is a 409 with today's text, and no credit note is minted", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 0 });
      const err = await failure(refund("CREDIT_NOTE"));
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe("Only RECEIVED returns can be refunded");
      expect(creditNotesCreate).not.toHaveBeenCalled();
    });

    it("a return another request resolved while this one waited is a 409 (the loser of two refunds), nothing written", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-1",
        status: "REFUNDED",
        kind: "STANDARD",
      });
      const err = await failure(refund("CREDIT_NOTE"));
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe("Only RECEIVED returns can be refunded");
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("the store-credit mint is NOT inside the claim transaction", () => {
    it("creditNotes.create runs after the claim transaction has ended", async () => {
      await refund("CREDIT_NOTE");
      expect(creditNotesCreate).toHaveBeenCalledTimes(1);
      expect(createdInsideTx).toBe(false);
      // and the claim committed before it: the one transaction call finished first
      expect(prisma.tenantTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        creditNotesCreate.mock.invocationCallOrder[0],
      );
    });

    it("a failed mint still bounces the claim back to RECEIVED (B68 compensation unchanged)", async () => {
      creditNotesCreate.mockRejectedValue(new Error("boom"));
      await failure(refund("CREDIT_NOTE"));
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.return.updateMany.mock.calls[1][0]).toEqual({
        where: { id: "ret-1", status: "REFUNDED", creditNoteId: null },
        data: { status: "RECEIVED", refundMethod: null, refundAmount: null, refundedAt: null },
      });
    });
  });

  describe("the basis is recomputed under the lock; the first figure is never claimed", () => {
    it.each(["CREDIT_NOTE", "EXTERNAL_REFUND"] as const)(
      "%s: the only invoice was voided while the refund waited -> 409 RETURN_REFUND_BASIS_CHANGED, nothing claimed",
      async (method) => {
        after = [{ id: "inv-1", status: "VOID", total: 100, payments: paidCash(100) }];
        const err = await failure(refund(method));
        expect(err).toBeInstanceOf(ConflictException);
        expect(codeOf(err)).toBe("RETURN_REFUND_BASIS_CHANGED");
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
        expect(creditNotesCreate).not.toHaveBeenCalled();
      },
    );

    it("a restated invoice changes the figure: the claim carries the figure read under the lock", async () => {
      after = [
        { id: "inv-1", status: "SENT", total: 200, payments: paidCash(200), lineSubtotal: 200 },
      ];
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 200, invoice: { orderId: "ord-1" } },
      ]);
      await refund("EXTERNAL_REFUND");
      expect(prisma.return.updateMany.mock.calls[0][0].data.refundAmount).toBe(40);
    });

    it("the same for store credit: the credit note is minted for the figure read under the lock", async () => {
      after = [
        { id: "inv-1", status: "SENT", total: 200, payments: paidCash(200), lineSubtotal: 200 },
      ];
      await refund("CREDIT_NOTE");
      expect(prisma.return.updateMany.mock.calls[0][0].data.refundAmount).toBe(40);
      expect(creditNotesCreate.mock.calls[0][0].amount).toBe(40);
    });
  });

  describe("a lock wait that times out is a coded, retryable 409, never a bare 500", () => {
    it("SQLSTATE 55P03 on a row lock -> 409 CONCURRENT_UPDATE retryable", async () => {
      const base = prisma.tenantTransaction.getMockImplementation()!;
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        base((tx: any) =>
          fn({
            ...tx,
            $executeRaw: jest.fn((strings: TemplateStringsArray) => {
              const text = strings.join("?");
              if (/FROM "Order"/.test(text)) {
                return Promise.reject(
                  Object.assign(new Error("canceling statement due to lock timeout"), {
                    meta: { code: "55P03" },
                  }),
                );
              }
              return Promise.resolve(0);
            }),
          }),
        ),
      );
      const err = await failure(refund("CREDIT_NOTE"));
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "CONCURRENT_UPDATE", retryable: true });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("the wait is bounded: the transaction sets lock_timeout before its first row lock", async () => {
      await refund("CREDIT_NOTE");
      const timeout = raw.findIndex((t) => /set_config\('lock_timeout'/.test(t));
      const firstRowLock = raw.findIndex((t) => /FOR UPDATE/.test(t));
      expect(timeout).toBeGreaterThanOrEqual(0);
      expect(timeout).toBeLessThan(firstRowLock);
    });
  });
});
