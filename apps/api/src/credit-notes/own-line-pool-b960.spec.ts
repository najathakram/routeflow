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
      .filter((w: any) => w.invoiceId === "inv-y");
    expect(own.length).toBeGreaterThan(0);
    for (const w of own) expect(w.id).toEqual({ not: "cn-old" });
  });

  it("6. the pool alone attributes the lump: with the pool active the own-line read never queries the per-invoice legacy term (no itemless-note read by invoiceId)", async () => {
    const db = fakeDb();
    await service.validateAndBuildCnItems(db, onY(100), {});
    const byInvoice = db.creditNote.findMany.mock.calls.filter(
      (c: any[]) => c[0].where.invoiceId !== undefined,
    );
    expect(byInvoice).toEqual([]);
  });
});
