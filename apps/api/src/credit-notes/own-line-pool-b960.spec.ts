import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B960 (LOW money): create()'s OWN-invoice line check read loadLineCredits WITH its per-invoice legacy term (an itemless refund
 * lump on THAT invoice, attributed to that invoice's lines) while the order pool attributes the same lump across the combined
 * lines. With the pool active the two disagreed: a credit note item on Y's P line was refused (the lump on Y "filled" Y's line)
 * although the POOL had room (the lump attributed to X's line first). Conservative, not a leak, but not "one headroom". With the
 * pool active (2+ creditable invoices) the own-line check now skips the legacy term and the pool is the ONE source for lumps; the
 * line's own CN items and inline returns still bind per line. One creditable invoice: unchanged.
 */
describe("CreditNotesService.validateAndBuildCnItems: B960 own-line check vs the order pool", () => {
  let service: CreditNotesService;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  const row = (id: string, productId: string, subtotal: number, qty = 1) => ({
    id,
    productId,
    subtotal,
    qty,
    boxes: null,
    unitsPerBox: null,
    pieces: null,
    product: { unitsPerBox: null },
    trackedCategoryId: null,
    categoryTaxAmount: 0,
  });
  const xP = row("x-p", "pp", 100); // product P on X (id sorts first)
  const yP = row("y-p", "pp", 100); // product P on Y

  interface Fx {
    creditable?: number; // creditable invoices on the order
    lump?: boolean; // an itemless refund lump of P (qty 1) on Y
    cnItems?: Array<{ invoiceId: string; invoiceItemId: string; amount: number; qty: number }>;
  }
  const fakeDb = (f: Fx = {}) => {
    const creditable = f.creditable ?? 2;
    const invoices = [
      { id: "inv-x", items: [xP] },
      { id: "inv-y", items: [yP] },
    ].slice(0, creditable === 1 ? 1 : 2);
    const lump = f.lump ?? true;
    return {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          total: 200,
          customerId: "cust-1",
          status: "SENT",
          orderId: "ord-1",
          items: [yP],
        }),
        count: jest.fn().mockResolvedValue(creditable),
        findMany: jest.fn().mockResolvedValue(invoices),
      },
      creditNote: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: lump ? 100 : 0 } }),
        // the per-invoice legacy term (by invoiceId = Y) finds the lump; so does the POOL read (by OR)
        findMany: jest.fn(async (args: any) =>
          lump && (args.where.invoiceId === undefined || args.where.invoiceId === "inv-y")
            ? [{ id: "cn-lump" }]
            : [],
        ),
      },
      creditNoteItem: {
        findMany: jest.fn(async (args: any) =>
          (f.cnItems ?? []).filter(
            (r) =>
              args.where.creditNote.invoiceId === r.invoiceId &&
              args.where.invoiceItemId.in.includes(r.invoiceItemId),
          ),
        ),
      },
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      return: { findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pp", qty: 1 }] }]) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
  };
  const onY = (amount: number) => ({
    customerId: "cust-1",
    invoiceId: "inv-y",
    amount,
    items: [{ invoiceItemId: "y-p", amount }],
  });

  it("1. RED REPRO: P on X and Y, a $100 refund lump on Y; a $100 credit note item on Y's P line fits the POOL ($100 + $100 of $200): it PASSES (it was refused by Y's own legacy term)", async () => {
    await expect(service.validateAndBuildCnItems(fakeDb(), onY(100), {})).resolves.toHaveLength(1);
  });

  it("2. a take that really exceeds the POOLED room is still refused by the pool: another $100 on X's line too would total $300 of $200", async () => {
    const db = fakeDb({
      cnItems: [{ invoiceId: "inv-x", invoiceItemId: "x-p", amount: 100, qty: 1 }],
    });
    await expect(service.validateAndBuildCnItems(db, onY(100), {})).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
    });
  });

  it("3. ONE creditable invoice is unchanged: the own-line check keeps the legacy term, so a lump on that invoice still fills its line", async () => {
    const db = fakeDb({ creditable: 1 });
    await expect(service.validateAndBuildCnItems(db, onY(100), {})).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
    });
  });

  it("4. the line's OWN credit note items still bind per line with the pool active: $100 already itemised on Y's P line refuses another $100 there", async () => {
    const db = fakeDb({
      lump: false,
      cnItems: [{ invoiceId: "inv-y", invoiceItemId: "y-p", amount: 100, qty: 1 }],
    });
    await expect(service.validateAndBuildCnItems(db, onY(100), {})).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
    });
  });

  it("5. the reissue dry run's excludeCreditNoteId is still threaded into the own-line read", async () => {
    const db = fakeDb({ lump: false });
    await service.validateAndBuildCnItems(db, onY(50), { excludeCreditNoteId: "cn-old" });
    const own = db.creditNoteItem.findMany.mock.calls
      .map((c: any[]) => c[0].where.creditNote)
      // (SA-773's remainder read has no credit note relation filter: it filters VOID in code)
      .filter((w: any) => w?.invoiceId === "inv-y");
    expect(own.length).toBeGreaterThan(0);
    for (const w of own) expect(w.id).toEqual({ not: "cn-old" });
  });

  it("6. the pool alone attributes the lump: with the pool active the own-line read never queries the per-invoice legacy term (no itemless-note read by invoiceId)", async () => {
    const db = fakeDb();
    await service.validateAndBuildCnItems(db, onY(100), {});
    // the legacy term reads ONE invoice id (a string); SA-773's remainder reads the amount-only notes of a set (`{ in }`)
    const byInvoice = db.creditNote.findMany.mock.calls.filter(
      (c: any[]) => typeof c[0].where.invoiceId === "string",
    );
    expect(byInvoice).toEqual([]);
  });

  describe("OPUS B960 review: qty stays bound at PRODUCT level once the pool is the only source for lumps", () => {
    // P on A (L1: 10 pieces, $100) and B (L2: 10 pieces, $10; B also bills Q so its invoice total has room). A refund lump of 10
    // pieces on B prices at the pooled average ($55) and the pool attributes it to L1 (A's id sorts first). Before the review fix
    // the pool bound qty only for an EXPLICIT qty, so amount-only credits could take 10 + 10 + 4.5 = 24.5 pieces of 20 billed.
    const l1 = row("a-l1", "pp", 100, 10);
    const l2 = row("b-l2", "pp", 10, 10);
    const db = (
      cn: Array<{ invoiceId: string; invoiceItemId: string; amount: number; qty: number }>,
      own: any,
    ) => ({
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          total: 200,
          customerId: "cust-1",
          status: "SENT",
          orderId: "ord-1",
          items: [own],
        }),
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          { id: "inv-a", items: [l1] },
          { id: "inv-b", items: [l2, row("b-q", "pq", 100)] },
        ]),
      },
      creditNote: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 55 } }),
        findMany: jest.fn(async (args: any) =>
          args.where.invoiceId === undefined ? [{ id: "cn-lump" }] : [],
        ),
      },
      creditNoteItem: {
        findMany: jest.fn(async (args: any) =>
          cn.filter(
            (r) =>
              args.where.creditNote.invoiceId === r.invoiceId &&
              args.where.invoiceItemId.in.includes(r.invoiceItemId),
          ),
        ),
      },
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      return: {
        findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pp", qty: 10 }] }]),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
    });

    it("an amount-only $10 credit on B's L2 (10 pieces) fits the pool: it passes", async () => {
      const dto = {
        customerId: "cust-1",
        invoiceId: "inv-b",
        amount: 10,
        items: [{ invoiceItemId: "b-l2", amount: 10 }],
      };
      await expect(service.validateAndBuildCnItems(db([], l2), dto, {})).resolves.toHaveLength(1);
    });

    it("then an amount-only $45 credit on A's L1 (derived qty 4.5) is REFUSED: no pieces are left in the pool (it used to pass: 24.5 of 20)", async () => {
      const dto = {
        customerId: "cust-1",
        invoiceId: "inv-a",
        amount: 45,
        items: [{ invoiceItemId: "a-l1", amount: 45 }],
      };
      await expect(
        service.validateAndBuildCnItems(
          db([{ invoiceId: "inv-b", invoiceItemId: "b-l2", amount: 10, qty: 10 }], l1),
          dto,
          {},
        ),
      ).rejects.toMatchObject({ response: { code: "CREDIT_NOTE_OVER_HEADROOM" } });
    });
  });
});
