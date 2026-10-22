/**
 * SA-839 (#1478 / B705, #1479 / B706, B693) red-first, unit lane: the REAL writers over a REAL
 * RegulatedLedgerService and ONE in-memory ledger (./testing/sa839-ledger-world.ts, the
 * regulated-ledger.sa835-lifecycle.spec.ts shape). Every assertion reads the line's signed Σ back out of
 * the rows the writers left (qty / unitBasisQty / net / tax), never a call argument.
 *
 * Fixture (ruling §5): one regulated line, SALE 10 / 10 / 100.00 / 20.00 in 2026-09; return r1 of 3 =
 * -3 / -3 / -30.00 / -6.00. The DB twins (R2, R4, R5, R12, R14) and the race probe (R15) live in
 * ./sa839-void-unvoid-undo.db.spec.ts; the structural pins (R16) in ./sa839-ledger-pins.spec.ts.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { InvoicesService } from "../invoices/invoices.service";
import { buildSplitInvoicesService } from "../invoices/testing/split-invoice-service";
import { ReturnsService } from "../returns/returns.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { Sa839LedgerWorld, type LineSum } from "./testing/sa839-ledger-world";

const OPERATOR = { sub: "user-op-1", role: "OPERATOR", tenantId: "test-tenant" } as any;
const ZERO: LineSum = { qty: 0, unitBasisQty: 0, net: 0, tax: 0 };
const FULL: LineSum = { qty: 10, unitBasisQty: 10, net: 100, tax: 20 };

/** Fake only the clock (Date), so the services' own awaits and retry back-offs still run. */
const at = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
      "hrtime",
      "performance",
    ],
  });

describe("SA-839: regulated ledger void / unvoid / undo (unit lane, real ledger)", () => {
  let w: Sa839LedgerWorld;
  let invoices: InvoicesService;
  let returns: ReturnsService;
  let inline: InlineReturnsService;
  let notes: CreditNotesService;
  let cancelStandaloneInTx: jest.Mock;

  beforeEach(async () => {
    w = new Sa839LedgerWorld();
    const p = w.prisma as any;
    invoices = await buildSplitInvoicesService(InvoicesService, p, w.service as any);

    const numbering = { reserveNext: jest.fn() };
    returns = (
      await Test.createTestingModule({
        providers: [
          ReturnsService,
          { provide: PrismaService, useValue: p },
          { provide: RegulatedLedgerService, useValue: w.service },
          { provide: NumberingService, useValue: numbering },
          { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
          { provide: CreditNotesService, useValue: { create: jest.fn() } },
        ],
      }).compile()
    ).get(ReturnsService);

    cancelStandaloneInTx = jest.fn().mockResolvedValue({ restored: 0 });
    inline = (
      await Test.createTestingModule({
        providers: [
          InlineReturnsService,
          { provide: PrismaService, useValue: p },
          { provide: RegulatedLedgerService, useValue: w.service },
          { provide: NumberingService, useValue: numbering },
          { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
          { provide: CreditNotesService, useValue: { cancelStandaloneInTx } },
          { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
          { provide: InlineReturnsQuoteService, useValue: { priceInlineReturn: jest.fn() } },
          { provide: IdempotencyService, useValue: { acquireLock: jest.fn() } },
        ],
      }).compile()
    ).get(InlineReturnsService);

    notes = (
      await Test.createTestingModule({
        providers: [
          CreditNotesService,
          { provide: PrismaService, useValue: p },
          { provide: RegulatedLedgerService, useValue: w.service },
          { provide: NumberingService, useValue: numbering },
          {
            provide: RouteFlowGateway,
            useValue: { emitCreditNoteVoided: jest.fn(), emitCreditNoteCreated: jest.fn() },
          },
          {
            provide: CommissionEngineService,
            useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }).compile()
    ).get(CreditNotesService);
  });

  afterEach(() => jest.useRealTimers());

  const voidInv = (id = "inv-1") => invoices.voidInvoiceInTx(w.prisma, id, "ord-1");
  const unvoid = (id = "inv-1") => invoices.unvoidInvoice(id);

  it("R1: void -> unvoid re-books the line (a new SALE in the unvoid's period)", async () => {
    w.seedSale();
    await voidInv();
    expect(w.sum()).toEqual(ZERO);

    at("2026-10-20T12:00:00Z");
    await unvoid();

    expect(w.invoiceStatus()).toBe("DRAFT");
    expect(w.sum()).toEqual(FULL);
    const sales = w.ledger.filter((r) => r.entryType === "SALE");
    expect(sales).toHaveLength(2);
    expect(sales[1].periodBucket).toBe("2026-10");
  });

  it("R2: void -> unvoid -> void -> unvoid steps 0, 10, 0, 10; ends with 3 SALE + 2 REVERSAL", async () => {
    w.seedSale();
    await voidInv();
    expect(w.sum().qty).toBe(0);
    await unvoid();
    expect(w.sum()).toEqual(FULL);
    await voidInv();
    expect(w.sum()).toEqual(ZERO);
    await unvoid();
    expect(w.sum()).toEqual(FULL);
    expect(w.ledger.filter((r) => r.entryType === "SALE")).toHaveLength(3);
    expect(w.ledger.filter((r) => r.entryType === "REVERSAL")).toHaveLength(2);
  });

  it("R3: return r1 BEFORE the void -> void -> unvoid keeps the live return (7 / 7 / 70.00 / 14.00)", async () => {
    w.seedSale();
    w.addReturn("r1");
    w.seedReturnRow("r1");
    await voidInv();
    expect(w.sum()).toEqual(ZERO);
    await unvoid();
    expect(w.sum()).toEqual({ qty: 7, unitBasisQty: 7, net: 70, tax: 14 });
  });

  it("R4: return r1 -> void -> cancel r1 (STANDARD) leaves the VOID line at 0; r1's row is kept, Σ(r1) = 0", async () => {
    w.seedSale();
    w.addReturn("r1");
    const r1 = w.seedReturnRow("r1");
    await voidInv();
    await returns.cancel("r1", OPERATOR);

    expect(w.returns.get("r1")!.status).toBe("CANCELLED");
    expect(w.invoiceStatus()).toBe("VOID");
    expect(w.sum()).toEqual(ZERO);
    expect(w.ledger.some((r) => r.id === r1.id)).toBe(true);
    expect(w.sum((r) => r.returnId === "r1")).toEqual(ZERO);
  });

  it("R5: R4 as an INLINE return (PIECES) leaves the VOID line at 0", async () => {
    w.seedSale();
    w.addReturn("r1", { kind: "INLINE", items: [{ productId: "p-1", qty: 3, restock: false }] });
    w.seedReturnRow("r1");
    await voidInv();
    await inline.cancel("r1", OPERATOR);

    expect(w.returns.get("r1")!.status).toBe("CANCELLED");
    expect(w.sum()).toEqual(ZERO);
    expect(w.sum((r) => r.returnId === "r1")).toEqual(ZERO);
  });

  it("R6: R4 then unvoid: the DRAFT bills 10 and the line holds 10 / 10 / 100.00 / 20.00", async () => {
    w.seedSale();
    w.addReturn("r1");
    w.seedReturnRow("r1");
    await voidInv();
    await returns.cancel("r1", OPERATOR);
    await unvoid();
    expect(w.invoiceStatus()).toBe("DRAFT");
    expect(w.sum()).toEqual(FULL);
  });

  it("R7: a legacy VOID credit note's reversal (rows as master wrote them) does not survive the unvoid (5 / 25.00 / 2.00)", async () => {
    w.seedSale({ qty: 5, net: 25, tax: 2 });
    w.addCreditNote("cn-1", { status: "VOID" });
    w.addRow({
      entryType: "REVERSAL",
      creditNoteId: "cn-1",
      qty: -2,
      unitBasisQty: -2,
      netSales: -10,
      categoryTax: -0.8,
      soldAt: new Date(Date.UTC(2026, 9, 2)),
      periodBucket: "2026-10",
    });
    // master's void: the ledger call ran BEFORE the note loop, netting only the remaining 3
    w.addRow({
      entryType: "REVERSAL",
      qty: -3,
      unitBasisQty: -3,
      netSales: -15,
      categoryTax: -1.2,
      soldAt: new Date(Date.UTC(2026, 9, 3)),
      periodBucket: "2026-10",
    });
    w.db.invoices[0].status = "VOID";
    w.db.line("oi-1").invoicedQty = 0;

    await unvoid();
    expect(w.sum()).toEqual({ qty: 5, unitBasisQty: 5, net: 25, tax: 2 });
  });

  it("R7b: a void with an UNUSED sourced note flips the note first: line 0 and Σ(creditNoteId) = 0; a later unvoid gives 5", async () => {
    w.seedSale({ qty: 5, net: 25, tax: 2 });
    w.addCreditNote("cn-1", { status: "ISSUED", amount: 10, amountUsed: 0 });
    w.addRow({
      entryType: "REVERSAL",
      creditNoteId: "cn-1",
      qty: -2,
      unitBasisQty: -2,
      netSales: -10,
      categoryTax: -0.8,
      soldAt: new Date(Date.UTC(2026, 9, 2)),
      periodBucket: "2026-10",
    });

    await voidInv();
    expect(w.creditNotes.get("cn-1")!.status).toBe("VOID");
    expect(w.sum()).toEqual(ZERO);
    expect(w.sum((r) => r.creditNoteId === "cn-1")).toEqual(ZERO);

    await unvoid();
    expect(w.sum()).toEqual({ qty: 5, unitBasisQty: 5, net: 25, tax: 2 });
  });

  it("R8: return r1 -> cancel on a LIVE invoice: total 10, r1's month stays -30.00, +30.00 lands in the cancel's month", async () => {
    w.seedSale();
    w.addReturn("r1");
    w.seedReturnRow("r1"); // booked in 2026-10
    at("2026-11-04T09:00:00Z");
    await returns.cancel("r1", OPERATOR);

    expect(w.sum()).toEqual(FULL);
    expect(w.bucketSum("2026-10")).toEqual({ qty: -3, unitBasisQty: -3, net: -30, tax: -6 });
    expect(w.bucketSum("2026-11")).toEqual({ qty: 3, unitBasisQty: 3, net: 30, tax: 6 });
  });

  it("R9 (guard): void -> a return received AFTER the void (capped at 0) -> cancel writes nothing", async () => {
    w.seedSale();
    await voidInv();
    w.addReturn("r1");
    await w.service.reverseReturnEntries({
      returnId: "r1",
      orderId: "ord-1",
      returnedByProduct: new Map([["p-1", 3]]),
      returnedUnit: "LINE_UNIT",
      db: w.prisma,
    });
    expect(w.ledger.filter((r) => r.returnId === "r1")).toHaveLength(0);
    const before = w.ledger.length;

    await returns.cancel("r1", OPERATOR);
    expect(w.sum()).toEqual(ZERO);
    expect(w.ledger).toHaveLength(before);
  });

  it.each([
    ["a live invoice", false],
    ["a VOID invoice", true],
  ])(
    "R10 (guard): undoing the same return twice writes 0 rows the second time (%s)",
    async (_label, voided) => {
      w.seedSale();
      w.addReturn("r1");
      w.seedReturnRow("r1");
      if (voided) await voidInv();
      await returns.cancel("r1", OPERATOR);
      const after1 = w.ledger.map((r) => r.id);
      // the second undo of r1, as a retried transaction would run it (the CANCELLED claim already won)
      w.returns.get("r1")!.status = "RECEIVED";
      await returns.cancel("r1", OPERATOR);
      expect(w.ledger.map((r) => r.id)).toEqual(after1);
    },
  );

  it("R11 (guard): an unvoid refused by the B299 re-claim (409) leaves the ledger and the VOID untouched", async () => {
    w.seedSale();
    await voidInv();
    w.db.line("oi-1").invoicedQty = 10; // another invoice now bills the goods
    const before = w.ledger.map((r) => ({ ...r }));

    await expect(unvoid()).rejects.toMatchObject({ status: 409 });
    expect(w.invoiceStatus()).toBe("VOID");
    expect(w.ledger).toEqual(before);
  });

  it("R13: SALE 2026-09, void 2026-10 (GENERATED filing), unvoid 2026-11: rows only in 2026-11, amendedPeriod 2026-10", async () => {
    w.seedSale();
    w.addFiling("2026-10", "GENERATED");
    at("2026-10-15T12:00:00Z");
    await voidInv();
    const sep = w.bucketSum("2026-09");
    const oct = w.bucketSum("2026-10");
    const before = w.ledger.length;

    at("2026-11-03T12:00:00Z");
    const res: any = await unvoid();

    const added = w.ledger.slice(before);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((r) => r.periodBucket === "2026-11")).toBe(true);
    expect(w.bucketSum("2026-09")).toEqual(sep);
    expect(w.bucketSum("2026-10")).toEqual(oct);
    expect(w.sum()).toEqual(FULL);
    expect(res.amendedPeriod).toEqual(
      expect.objectContaining({
        periodKey: "2026-10",
        status: "GENERATED",
        trackedCategoryId: "cat-A",
      }),
    );
  });

  it("R14: a credit-note void AFTER the invoice void (the note capped APPLIED by the void) leaves the line at 0", async () => {
    w.seedSale({ qty: 5, net: 25, tax: 2 });
    // used 3 of 10: the invoice void caps it to APPLIED and leaves its reversal standing
    w.addCreditNote("cn-1", { status: "ISSUED", amount: 10, amountUsed: 3 });
    w.addRow({
      entryType: "REVERSAL",
      creditNoteId: "cn-1",
      qty: -3,
      unitBasisQty: -3,
      netSales: -15,
      categoryTax: -1.2,
      soldAt: new Date(Date.UTC(2026, 9, 2)),
      periodBucket: "2026-10",
    });
    await voidInv();
    expect(w.creditNotes.get("cn-1")).toMatchObject({ status: "APPLIED", amount: 3 });
    expect(w.sum()).toEqual(ZERO);

    // its use is pulled back elsewhere (no live payment remains), then the note is voided
    w.creditNotes.get("cn-1")!.amountUsed = 0;
    await notes.voidWithReversal("cn-1", "user-op-1");

    expect(w.creditNotes.get("cn-1")!.status).toBe("VOID");
    expect(w.sum()).toEqual(ZERO);
  });
});
