/**
 * P5-13 WP5: ReturnsService.processRefund() — approving a return's refund creates a
 * lump-sum store credit (no line items — the regulated ledger was already reversed
 * at receive()). Refund value = Σ returned qty × the order line's EFFECTIVE
 * per-unit price (subtotal ÷ qty, boxed-safe — NOT qty × unitPrice).
 *
 * WP9 (2026-07-30): processRefund(id, dto?) now folds a CREDIT_NOTE | EXTERNAL_REFUND
 * method choice into the SAME atomic RECEIVED→REFUNDED claim (refundMethod/refundAmount/
 * refundedAt persist in one write), and receive() accepts APPROVED as well as IN_TRANSIT
 * and can suppress restocking via { restock: false }.
 *
 * F08 (2026-09-06, REG-B53/B68/B69/B75): the refund basis moves from the ORDER LINE to
 * what was actually BILLED — the order's non-VOID/non-WRITTEN_OFF ("creditable")
 * invoice(s). A single creditable invoice sources the credit; 2+ mint against the LATEST
 * one, capped by a headroom check; none creditable (but invoices exist) refuses; zero
 * invoices at all keeps the legacy order-line fallback. Refund qty is capped at the
 * BILLED qty (`min(returned, billed)`); narrowing it further by what was already
 * DELIVERED needs a `ReturnItem.deliveredQty` column and is filed separately. B68: a failed
 * credit-note mint now compensates the RECEIVED→REFUNDED claim instead of stranding the
 * row. B69: cancel()'s undo now keys off the FRESH in-tx return status/items, not the
 * stale pre-transaction read.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * F08 round 4: build the `order.invoices` rows a mocked `return.findUnique` returns by
 * PROJECTING a full invoice record through the `select` processRefund actually passed, so
 * a fixture can never hand the service a field the production query never asked for. Drop
 * `invoiceNumber: true` from that select and every row built here loses it too — which is
 * what makes the "the refusal names the human invoice number" pins below a claim about the
 * QUERY, not just about the message template. `items` (a nested select) passes through
 * whole; the service only reads the fields it selected on it.
 */
function invoicesAsSelected(args: any, rows: Record<string, any>[]): Record<string, any>[] {
  const select = args?.include?.order?.select?.invoices?.select ?? {};
  if (Object.keys(select).length === 0) {
    throw new Error("processRefund's order.invoices select was not found on the findUnique args");
  }
  return rows.map((row) => {
    const projected: Record<string, any> = {};
    for (const [field, wanted] of Object.entries(select)) {
      if (!wanted || !(field in row)) continue;
      projected[field] = row[field];
    }
    return projected;
  });
}

describe("ReturnsService.processRefund → dispute creates a store credit (P5-13 WP5)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;
  let ledger: { reverseReturnEntries: jest.Mock; unreverseReturnEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn();
    ledger = { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-2026-0001") },
        },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("REG-B53 no body: defaults to CREDIT_NOTE, mints Σ qty × (subtotal ÷ qty) of the BILLED invoice — NOT the order line — and persists the resolution snapshot", async () => {
    // Order line: qty 10, subtotal 100 (perUnit 10) — now a DECOY once an invoice exists.
    // Billed (invoice) basis: qty 8, subtotal 88 (perUnit 11) for the SAME product, so 2
    // returned units refund 2 × 11 = 22, not the order line's 2 × 10 = 20.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-2026-001",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-001",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 88,
            items: [{ productId: "p1", qty: 8, subtotal: 88 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 }); // atomic RECEIVED→REFUNDED claim
    prisma.return.update.mockResolvedValue({
      id: "ret-1",
      status: "REFUNDED",
      creditNoteId: "cn-1",
    }); // the linkage write
    creditNotesCreate.mockResolvedValue({ id: "cn-1", creditNoteNumber: "CN-2026-0001" });

    const result = await service.processRefund("ret-1");

    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.customerId).toBe("cust-1");
    expect(dto.invoiceId).toBe("inv-1");
    expect(dto.amount).toBe(22); // 2 × (88 / 8) billed, NOT 2 × (100 / 10) order-line
    expect(dto.items).toBeUndefined(); // lump-sum — no line linkage
    expect(dto.reason).toContain("RET-2026-001");

    // The RECEIVED→REFUNDED flip is an atomic conditional claim (updateMany) that ALSO
    // persists the resolution snapshot in the same write, so a concurrent double-refund
    // can't mint two credits or record two resolutions; update() is only the linkage.
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-1", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 22,
        refundedAt: expect.any(Date),
      },
    });
    // T16 pin (REG-B68): a successful mint never triggers the compensation path — the
    // claim fires exactly once.
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.return.update).toHaveBeenCalledTimes(1);
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: { creditNoteId: "cn-1" },
    });
    expect(result.creditNoteId).toBe("cn-1");
  });

  it("REG-B53 2+ creditable invoices mint against the LATEST one (not a standalone credit)", async () => {
    // Pre-fix, 2+ invoices always meant `invoiceId: undefined` (a standalone credit) —
    // that skipped create()'s per-invoice cap entirely. The fix instead mints against the
    // LATEST creditable invoice (by createdAt) so the cap applies, gated by headroom.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-2",
      returnNumber: "RET-2026-002",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 1 }],
      order: {
        orderNumber: "ORD-002",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            createdAt: new Date("2026-01-01"),
            items: [{ productId: "p1", qty: 5, subtotal: 100 }],
          },
          {
            id: "inv-2",
            status: "SENT",
            total: 100,
            createdAt: new Date("2026-02-01"),
            items: [{ productId: "p1", qty: 5, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 5, unitPrice: 20, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({ id: "ret-2", status: "REFUNDED" });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } }); // ample headroom
    creditNotesCreate.mockResolvedValue({ id: "cn-2", creditNoteNumber: "CN-2026-0002" });

    await service.processRefund("ret-2");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.invoiceId).toBe("inv-2"); // the LATER of the two invoices, not undefined
  });

  it("F09 A2 (re-pointed by F08): an order with NO invoice rows mints an unsourced credit note", async () => {
    // F09 A2 pin, re-stated for F08: this fixture is the ZERO-INVOICE order (the order
    // was never invoiced, or its invoice rows are gone). It must never reach create()'s
    // CREDIT_SOURCE_EXCLUDED guard AFTER the RECEIVED->REFUNDED claim has committed —
    // that threw and lost the refund with no recovery path. It mints an UNSOURCED credit
    // and resolves normally. The VOID-only order is a DIFFERENT case and must refuse:
    // see "REG-B53 no creditable invoice refuses" below, whose select pin forbids the
    // DB-level status filter that would collapse the two cases into this one.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-12",
      returnNumber: "RET-2026-012",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-012",
        invoices: [], // zero invoice rows: never invoiced / rows gone — the VOID-only case is
        // owned by "REG-B53 no creditable invoice refuses" below
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-12",
      status: "REFUNDED",
      creditNoteId: "cn-12",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-12", creditNoteNumber: "CN-2026-0012" });

    const result = await service.processRefund("ret-12");

    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.invoiceId).toBeUndefined();
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: "ret-12" },
      data: { creditNoteId: "cn-12" },
    });
    expect(result.creditNoteId).toBe("cn-12");
  });

  it("skips credit creation for a $0 refund (no matching items) but still flips REFUNDED", async () => {
    prisma.return.findUnique
      .mockResolvedValueOnce({
        id: "ret-3",
        returnNumber: "RET-2026-003",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p-not-on-order", qty: 3 }],
        order: {
          orderNumber: "ORD-003",
          invoices: [
            {
              id: "inv-1",
              status: "SENT",
              total: 100,
              items: [{ productId: "p1", qty: 10, subtotal: 100 }],
            },
          ],
          lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
        },
      })
      .mockResolvedValueOnce({ id: "ret-3", status: "REFUNDED" }); // refetch after the claim
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.processRefund("ret-3");

    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-3", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 0,
        refundedAt: expect.any(Date),
      },
    });
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "ret-3", status: "REFUNDED" });
  });

  it("rejects a non-RECEIVED return before any money math", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-4",
      returnNumber: "RET-2026-004",
      status: "APPROVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-004",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });

    await expect(service.processRefund("ret-4")).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it("aborts without minting a credit when the atomic claim is lost (count 0)", async () => {
    // A concurrent processRefund already flipped RECEIVED→REFUNDED, so this claim
    // matches 0 rows. Without the guard both invocations would each mint a store
    // credit — double-crediting the customer.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-5",
      returnNumber: "RET-2026-005",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-005",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.processRefund("ret-5")).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("REG-B53 rounds refundAmount to the cent on a box-priced BILLED fixture", async () => {
    // Order line (qty 3, subtotal 12) is now a DECOY. Billed (invoice) basis: qty 3,
    // subtotal 10 -> effective per-unit = 3.333...; returning 2 units gives a raw refund
    // of 6.6666...7, which must round half-up to 6.67.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-11",
      returnNumber: "RET-2026-011",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-011",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 10,
            items: [{ productId: "p1", qty: 3, subtotal: 10 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 3, unitPrice: 4, subtotal: 12 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-11",
      status: "REFUNDED",
      creditNoteId: "cn-11",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-11", creditNoteNumber: "CN-2026-0011" });

    await service.processRefund("ret-11");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.amount).toBe(6.67);
  });

  // ─── WP9: method choice — CREDIT_NOTE vs EXTERNAL_REFUND ────────────────────────

  it("REG-B53 { method: 'EXTERNAL_REFUND' } records the BILLED resolution but mints no credit note", async () => {
    // Order line (qty 10, subtotal 100 -> perUnit 10) is now a DECOY. Billed basis: qty 8,
    // subtotal 96 -> perUnit 12, so 2 returned units record 24, not the order line's 20.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-9",
      returnNumber: "RET-2026-009",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-009",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 96,
            items: [{ productId: "p1", qty: 8, subtotal: 96 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.processRefund("ret-9", { method: "EXTERNAL_REFUND" });

    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-9", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 24,
        refundedAt: expect.any(Date),
      },
    });
    expect(prisma.return.update).not.toHaveBeenCalled(); // no creditNoteId written
    expect(result).not.toHaveProperty("creditNoteId");
  });

  it("aborts an EXTERNAL_REFUND without recording anything when the atomic claim is lost (count 0)", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-10",
      returnNumber: "RET-2026-010",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-010",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.processRefund("ret-10", { method: "EXTERNAL_REFUND" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  // ─── F08: B53 billed-invoice basis and headroom cap ─────────────────────────────────

  it("REG-B53 refund is priced from the billed invoice basis, not the order line", async () => {
    // Order line: qty 10, subtotal 100 (perUnit 10) — a DECOY once an invoice exists.
    // Billed (invoice) basis: qty 6, subtotal 60 (perUnit 10) — return qty 10 is capped
    // at the 6 units actually billed, so refund = 6 × 10 = 60, not qty 10 × the order
    // line's own perUnit (100).
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53a",
      returnNumber: "RET-2026-053",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 10 }],
      order: {
        orderNumber: "ORD-053",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 60,
            items: [{ productId: "p1", qty: 6, subtotal: 60 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-53a",
      status: "REFUNDED",
      creditNoteId: "cn-53a",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-53a", creditNoteNumber: "CN-2026-0053" });

    await service.processRefund("ret-53a");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.amount).toBe(60); // billed basis (6 × 10), NOT the order line's 10 × 10 = 100
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-53a", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 60,
        refundedAt: expect.any(Date),
      },
    });
  });

  it("REG-B53 the single non-VOID invoice is the credit-note source", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53b",
      returnNumber: "RET-2026-054",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-054",
        invoices: [
          {
            id: "inv-1",
            status: "VOID",
            total: 50,
            items: [{ productId: "p1", qty: 5, subtotal: 50 }],
          },
          {
            id: "inv-2",
            status: "SENT",
            total: 50,
            items: [{ productId: "p1", qty: 5, subtotal: 50 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 5, unitPrice: 10, subtotal: 50 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-53b",
      status: "REFUNDED",
      creditNoteId: "cn-53b",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-53b", creditNoteNumber: "CN-2026-0054" });

    await service.processRefund("ret-53b");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.invoiceId).toBe("inv-2"); // the VOID invoice is never a credit source
  });

  it("REG-B53 two non-VOID invoices are capped by headroom", async () => {
    // Two $50 invoices ($100 billed) already have $90 of non-VOID credit notes against
    // them, leaving only $10 of headroom — this return's $20 (2 × $10/unit) exceeds it.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53c",
      returnNumber: "RET-2026-055",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        id: "ord-53c",
        orderNumber: "ORD-055",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 50,
            createdAt: new Date("2026-01-01"),
            items: [{ productId: "p1", qty: 5, subtotal: 50 }],
          },
          {
            id: "inv-2",
            status: "SENT",
            total: 50,
            createdAt: new Date("2026-02-01"),
            items: [{ productId: "p1", qty: 5, subtotal: 50 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-53c",
      status: "REFUNDED",
      creditNoteId: "cn-53c",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-53c", creditNoteNumber: "CN-2026-0055" });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 90 } });

    await expect(service.processRefund("ret-53c")).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
    // The refusal must come from a HEADROOM computation, not from a blanket "2+ invoices
    // are unsupported" bail-out: the sibling case above (same shape, aggregate _sum 0)
    // mints against inv-2, so the aggregate is what discriminates the two. (The exact
    // where-clause of the headroom query is not pinned here — the ruling does not fix
    // its scope — only that it is consulted.)
    expect(prisma.creditNote.aggregate).toHaveBeenCalled();
    // …except for one thing the ruling DOES fix: the credited side is scoped by the
    // ORDER, not by invoice id alone. An unsourced credit note (invoiceId null) linked
    // through OrderCreditNote must still reduce the headroom, or a later refund on the
    // same order sees inflated room and passes a check that should have refused.
    expect(prisma.creditNote.aggregate.mock.calls[0][0].where).toMatchObject({
      status: { not: "VOID" },
      OR: expect.arrayContaining([
        expect.objectContaining({ orderLinks: { some: { orderId: "ord-53c" } } }),
      ]),
    });
  });

  it("REG-B53 a refund larger than the SOURCE invoice's own room refuses BEFORE the claim", async () => {
    // Order-wide headroom is not the ceiling create() enforces: the credit is minted
    // against the LATEST invoice, and credit-notes.create() caps on THAT invoice alone.
    // Invoice A (older) $900 and invoice B (latest) $100 give $1000 of order-wide
    // headroom, so a $500 refund clears it — but B's own room is $100, so create() would
    // throw AFTER the RECEIVED→REFUNDED claim had committed, bouncing the row back
    // forever with an error naming an invoice the operator never chose.
    // Projected through processRefund's own select, like the single-invoice pin below:
    // the 2+ branch composes the SAME refusal, so it must name the same human number.
    (prisma.return.findUnique as unknown as jest.Mock).mockImplementation(async (args: any) => ({
      id: "ret-53f",
      returnNumber: "RET-2026-059",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 5 }],
      order: {
        id: "ord-53f",
        orderNumber: "ORD-059",
        invoices: invoicesAsSelected(args, [
          {
            id: "inv-a",
            invoiceNumber: "INV-059A",
            status: "SENT",
            total: 900,
            createdAt: new Date("2026-01-01"),
            items: [{ productId: "p1", qty: 9, subtotal: 900 }],
          },
          {
            id: "inv-b",
            invoiceNumber: "INV-059B",
            status: "SENT",
            total: 100,
            createdAt: new Date("2026-02-01"),
            items: [{ productId: "p1", qty: 1, subtotal: 100 }],
          },
        ]),
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 100, subtotal: 1000 }],
      },
    }));
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    creditNotesCreate.mockResolvedValue({ id: "cn-53f", creditNoteNumber: "CN-2026-0059" });

    const err = await service.processRefund("ret-53f").catch((e: any) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    // Names the LATEST invoice — by its human number, not the row id.
    expect(err.message).toContain("INV-059B");
    expect(err.message).not.toContain("inv-b");
    // Refused BEFORE the claim: no status write, no mint, no compensation churn.
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("REG-B53 a SINGLE creditable invoice is capped by its OWN remaining room too", async () => {
    // credit-notes.create() caps on the source invoice regardless of how many invoices
    // the order has, so the single-invoice case needs the same pre-claim guard the 2+
    // case got: one $100 SENT invoice already carrying $70 of credit (an earlier partial
    // return) leaves $30 of room, and this return prices at $50. Without the guard the
    // RECEIVED->REFUNDED claim commits, create() throws, B68 bounces the row back to
    // RECEIVED, and the refund is unachievable by CREDIT_NOTE forever.
    // The invoice rows are PROJECTED through processRefund's own select (see
    // `invoicesAsSelected`), so the human number below only reaches billedBasisFor if the
    // production query selects `invoiceNumber`.
    (prisma.return.findUnique as unknown as jest.Mock).mockImplementation(async (args: any) => ({
      id: "ret-53g",
      returnNumber: "RET-2026-060",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 5 }],
      order: {
        id: "ord-53g",
        orderNumber: "ORD-060",
        invoices: invoicesAsSelected(args, [
          {
            id: "inv-only",
            invoiceNumber: "INV-060",
            status: "SENT",
            total: 100,
            createdAt: new Date("2026-01-01"),
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ]),
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
      },
    }));
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 70 } });
    creditNotesCreate.mockResolvedValue({ id: "cn-53g", creditNoteNumber: "CN-2026-0060" });

    const err = await service.processRefund("ret-53g").catch((e: any) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    // The operator reads this string: it must name the invoice the way the UI does — the
    // human number — and must NOT leak the row id, which the same select also carries.
    expect(err.message).toContain("INV-060");
    expect(err.message).not.toContain("inv-only");
    // Refused BEFORE the claim: no status write, no mint, no compensation churn.
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
    // It is the SOURCE-invoice check that refused, not the order-wide headroom one:
    // a single creditable invoice consults exactly one aggregate, scoped by invoiceId.
    expect(prisma.creditNote.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.creditNote.aggregate.mock.calls[0][0].where).toMatchObject({
      status: { not: "VOID" },
      invoiceId: "inv-only",
    });
  });

  it("REG-B53 the refusal's invoice name comes from the SELECT: a row without `invoiceNumber` degrades to the raw id", async () => {
    // The mirror of the pin above, and the reason that one is a claim about the query
    // rather than about the template: hand billedBasisFor the PRE-FIX row shape — an
    // invoice with no `invoiceNumber` — and the identical refusal falls back to a UUID no
    // operator can act on. This is what production emitted while the select omitted the
    // field, and it is exactly what the previous test would print if the field were
    // dropped again (the fixture there cannot supply what the select does not ask for).
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53g2",
      returnNumber: "RET-2026-061",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 5 }],
      order: {
        id: "ord-53g2",
        orderNumber: "ORD-061",
        invoices: [
          {
            // Deliberately NOT projected through the select — this is the old shape.
            id: "inv-unnamed",
            status: "SENT",
            total: 100,
            createdAt: new Date("2026-01-01"),
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 70 } });

    const err = await service.processRefund("ret-53g2").catch((e: any) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain("inv-unnamed"); // the fallback: an id, not a label
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("REG-B53 no creditable invoice refuses; no invoice at all falls back to the order line", async () => {
    // (a) The order's ONLY invoice is VOID — nothing billed is creditable, so
    // processRefund must refuse rather than mint from the order lines (as it does today).
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53e1",
      returnNumber: "RET-2026-057",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 10 }],
      order: {
        orderNumber: "ORD-057",
        invoices: [
          {
            id: "inv-1",
            status: "VOID",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({ id: "ret-53e1", status: "REFUNDED" });
    creditNotesCreate.mockResolvedValue({ id: "cn-53e1", creditNoteNumber: "CN-2026-0571" });

    const refusal = service.processRefund("ret-53e1");
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(/billed/i); // the refusal is about the billed basis
    expect(creditNotesCreate).not.toHaveBeenCalled();

    // The creditable/VOID decision must be made IN CODE. If the invoices select excludes
    // VOID/WRITTEN_OFF at the DB, a VOID-only order comes back with zero invoice rows and
    // is indistinguishable from the uninvoiced order in (b) below — silently taking the
    // legacy order-line fallback and over-refunding the exact 100 this case exists to
    // refuse, while still passing on a mock that hands the VOID row back.
    const refundQuery = JSON.stringify(prisma.return.findUnique.mock.calls[0][0] ?? {});
    expect(refundQuery).not.toContain("VOID");
    expect(refundQuery).not.toContain("WRITTEN_OFF");

    // (b) The order has NO invoice rows at all (pre-invoicing order) — falls back to the
    // legacy order-line basis: qty 10 × (100 / 10) = 100.
    creditNotesCreate.mockClear();
    prisma.return.updateMany.mockClear();
    prisma.return.update.mockClear();
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53e2",
      returnNumber: "RET-2026-058",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 10 }],
      order: {
        orderNumber: "ORD-058",
        invoices: [],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-53e2",
      status: "REFUNDED",
      creditNoteId: "cn-53e2",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-53e2", creditNoteNumber: "CN-2026-0582" });

    await service.processRefund("ret-53e2");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.amount).toBe(100);
  });

  it("REG-B53 EXTERNAL_REFUND on a VOID-only order still resolves (mints nothing)", async () => {
    // Same fixture as the refusal case above, resolved the other way: the money was
    // already returned by cash/card, so there is nothing to mint and nothing to cap.
    // The creditable/headroom refusals guard the MINT path only — applying them to
    // EXTERNAL_REFUND leaves the return stuck at RECEIVED with no transition out.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-53e3",
      returnNumber: "RET-2026-060",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 10 }],
      order: {
        id: "ord-53e3",
        orderNumber: "ORD-060",
        invoices: [
          {
            id: "inv-1",
            status: "VOID",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.processRefund("ret-53e3", { method: "EXTERNAL_REFUND" } as any),
    ).resolves.toBeDefined();

    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    const claim = prisma.return.updateMany.mock.calls[0][0];
    expect(claim.data).toMatchObject({
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: 0, // nothing creditable is billed, so nothing is recorded as credited
    });
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  // ─── F08: B68 a failed mint compensates the claim instead of stranding the return ──

  it("REG-B68 a failed credit-note mint compensates the RECEIVED→REFUNDED claim", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-68",
      returnNumber: "RET-2026-068",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-068",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    creditNotesCreate.mockRejectedValue(new BadRequestException("cap"));

    await expect(service.processRefund("ret-68")).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.return.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.return.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "ret-68", status: "REFUNDED", creditNoteId: null },
      data: { status: "RECEIVED", refundMethod: null, refundAmount: null, refundedAt: null },
    });
    expect(prisma.return.update).not.toHaveBeenCalled(); // no linkage — the mint never landed
  });

  it("REG-B68 a failed COMPENSATION never replaces the original mint error", async () => {
    // The compensating update most plausibly fails for the same reason the mint did
    // (DB down / pool exhausted). If that rejection escapes, the caller is told about
    // the compensation instead of the real cause and the row is stranded silently.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-68b",
      returnNumber: "RET-2026-069",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        id: "ord-68b",
        orderNumber: "ORD-069",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            items: [{ productId: "p1", qty: 10, subtotal: 100 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany
      .mockResolvedValueOnce({ count: 1 }) // the claim commits
      .mockRejectedValueOnce(new Error("db down")); // the compensation fails
    creditNotesCreate.mockRejectedValue(new BadRequestException("cap exceeded"));

    await expect(service.processRefund("ret-68b")).rejects.toThrow(/cap exceeded/);
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(2);
  });

  // ─── F08: B75 findAll surfaces refundEstimate from the same billed basis ───────────

  it("REG-B75 findAll rows carry refundEstimate from the billed basis", async () => {
    prisma.return.findMany.mockResolvedValue([
      {
        id: "ret-75",
        returnNumber: "RET-2026-075",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2 }],
        order: {
          id: "ord-75",
          orderNumber: "ORD-075",
          invoices: [
            {
              id: "inv-1",
              status: "SENT",
              total: 20,
              items: [{ productId: "p1", qty: 4, subtotal: 20 }],
            },
          ],
          lineItems: [{ productId: "p1", qty: 4, unitPrice: 6, subtotal: 24 }],
        },
        customer: { id: "cust-1", businessName: "Acme Co" },
      },
      {
        // Fully credited across TWO $50 invoices: the mint-time headroom gate would
        // refuse this ($100 already credited), and the old catch turned that refusal
        // into $0.00 in the Value column — the exact B75 symptom. A READ prices, it
        // does not gate.
        id: "ret-75b",
        returnNumber: "RET-2026-076",
        status: "REFUNDED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 10 }],
        order: {
          id: "ord-76",
          orderNumber: "ORD-076",
          invoices: [
            {
              id: "inv-a",
              status: "SENT",
              total: 50,
              createdAt: new Date("2026-01-01"),
              items: [{ productId: "p1", qty: 5, subtotal: 50 }],
            },
            {
              id: "inv-b",
              status: "SENT",
              total: 50,
              createdAt: new Date("2026-02-01"),
              items: [{ productId: "p1", qty: 5, subtotal: 50 }],
            },
          ],
          lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
        },
        customer: { id: "cust-1", businessName: "Acme Co" },
      },
      {
        // VOID-only order: a genuine "nothing creditable", reported as 0 WITH a reason
        // so the UI can tell it apart from a return that really is worth $0.
        id: "ret-75c",
        returnNumber: "RET-2026-077",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2 }],
        order: {
          id: "ord-77",
          orderNumber: "ORD-077",
          invoices: [
            {
              id: "inv-v",
              status: "VOID",
              total: 20,
              items: [{ productId: "p1", qty: 4, subtotal: 20 }],
            },
          ],
          lineItems: [{ productId: "p1", qty: 4, unitPrice: 6, subtotal: 24 }],
        },
        customer: { id: "cust-1", businessName: "Acme Co" },
      },
    ]);
    prisma.return.count.mockResolvedValue(3);

    const result = await service.findAll();

    // 2 units billed at $5/unit ($20 / 4) — NOT the order line's $6/unit.
    expect(result.data[0].refundEstimate).toBe(10);
    expect(result.data[0].refundEstimateReason).toBeNull();
    // The fully-credited multi-invoice row keeps its real billed value, never $0.
    expect(result.data[1].refundEstimate).toBe(100);
    expect(result.data[1].refundEstimateReason).toBeNull();
    // The VOID-only row is 0 — with the reason stated, not swallowed.
    expect(result.data[2].refundEstimate).toBe(0);
    expect(result.data[2].refundEstimateReason).toBe("NOTHING_CREDITABLE");

    // A list read issues NO per-row money query: the headroom aggregate belongs to the
    // mint path only (the web KPI fetches this list with limit 500).
    expect(prisma.creditNote.aggregate).not.toHaveBeenCalled();

    // The invoice graph is fetched only to price the rows — it must never cross the
    // wire (GET /returns is readable by DRIVER and CUSTOMER roles).
    expect(result.data[0].order).toEqual({ id: "ord-75", orderNumber: "ORD-075" });
    expect(result.data[0].order).not.toHaveProperty("invoices");
    expect(result.data[0].order).not.toHaveProperty("lineItems");
  });

  it("PR-1a fix-round F1 (red-first): the never-invoiced legacy basis pools a product's qty/subtotal across ALL its live lines — pricing a return against one line's rate while the qty is pooled over-credits", async () => {
    // Never-invoiced order: product p1 sold on TWO differently-priced lines —
    // 4 units @ $10 (line A, $40) and 6 units @ $5 (line B, $30) — 10 units total for
    // $70. A return of all 10 units must price at the BLENDED $7/unit ($70), never at
    // line A's $10/unit against the full pooled qty ($100 — the pre-fix defect: the
    // legacy `.find()` matched only line A, so `amount = 10 * (40/4) = $100`).
    prisma.return.findMany.mockResolvedValue([
      {
        id: "ret-f1",
        returnNumber: "RET-2026-F1",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 10 }],
        order: {
          id: "ord-f1",
          orderNumber: "ORD-F1",
          invoices: [],
          lineItems: [
            { productId: "p1", qty: 4, unitPrice: 10, subtotal: 40, status: "PENDING" },
            { productId: "p1", qty: 6, unitPrice: 5, subtotal: 30, status: "PENDING" },
          ],
        },
        customer: { id: "cust-1", businessName: "Acme Co" },
      },
    ]);
    prisma.return.count.mockResolvedValue(1);

    const result = await service.findAll();

    expect(result.data[0].refundEstimate).toBe(70);
    expect(result.data[0].refundEstimateReason).toBeNull();
  });

  it("PR-1a fix-round F1 (red-first): a CANCELLED line is excluded from the pooled never-invoiced basis", async () => {
    prisma.return.findMany.mockResolvedValue([
      {
        id: "ret-f1b",
        returnNumber: "RET-2026-F1B",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 4 }],
        order: {
          id: "ord-f1b",
          orderNumber: "ORD-F1B",
          invoices: [],
          lineItems: [
            { productId: "p1", qty: 4, unitPrice: 10, subtotal: 40, status: "PENDING" },
            // A cancelled line at a wildly different price must not drag the blended
            // rate off the live line's own $10/unit.
            { productId: "p1", qty: 100, unitPrice: 1, subtotal: 100, status: "CANCELLED" },
          ],
        },
        customer: { id: "cust-1", businessName: "Acme Co" },
      },
    ]);
    prisma.return.count.mockResolvedValue(1);

    const result = await service.findAll();

    expect(result.data[0].refundEstimate).toBe(40);
  });

  it("REG-B75 findOne prices refundEstimate from the BILLED basis, and states a VOID-only 0", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-75d",
      returnNumber: "RET-2026-078",
      status: "RECEIVED",
      customerId: "cust-1",
      creditNoteId: null,
      items: [{ productId: "p1", qty: 2 }],
      order: {
        id: "ord-78",
        orderNumber: "ORD-078",
        invoices: [
          {
            id: "inv-1",
            status: "SENT",
            total: 20,
            items: [{ productId: "p1", qty: 4, subtotal: 20 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 4, unitPrice: 6, subtotal: 24 }],
      },
      customer: { id: "cust-1", businessName: "Acme Co" },
    });

    const detail: any = await service.findOne("ret-75d");

    // Billed $5/unit ($20 / 4) × 2 = 10 — NOT the order line's $6/unit (= 12).
    expect(detail.refundEstimate).toBe(10);
    expect(detail.refundEstimateReason).toBeNull();
    expect(detail.order).not.toHaveProperty("invoices");

    // VOID-only order: 0 with a stated reason, and still no DB round trip for the estimate.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-75e",
      returnNumber: "RET-2026-079",
      status: "RECEIVED",
      customerId: "cust-1",
      creditNoteId: null,
      items: [{ productId: "p1", qty: 2 }],
      order: {
        id: "ord-79",
        orderNumber: "ORD-079",
        invoices: [
          {
            id: "inv-v",
            status: "VOID",
            total: 20,
            items: [{ productId: "p1", qty: 4, subtotal: 20 }],
          },
        ],
        lineItems: [{ productId: "p1", qty: 4, unitPrice: 6, subtotal: 24 }],
      },
      customer: { id: "cust-1", businessName: "Acme Co" },
    });

    const voided: any = await service.findOne("ret-75e");
    expect(voided.refundEstimate).toBe(0);
    expect(voided.refundEstimateReason).toBe("NOTHING_CREDITABLE");
    expect(prisma.creditNote.aggregate).not.toHaveBeenCalled();
  });

  it("a CUSTOMER with no Customer row sees an empty list, never the tenant-wide one", async () => {
    prisma.customer.findFirst.mockResolvedValue(null);

    const result = await service.findAllForUser({
      sub: "user-1",
      role: "CUSTOMER",
    } as any);

    expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    // Falling through with `customerId: undefined` would drop the scoping filter and
    // list every return in the tenant.
    expect(prisma.return.findMany).not.toHaveBeenCalled();
  });

  // ─── WP9: receive() accepts APPROVED as well as IN_TRANSIT, and can skip restocking ──

  describe("receive()", () => {
    it("is allowed from APPROVED (resolve-without-transit)", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-6",
        status: "APPROVED",
        orderId: "ord-6",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      // Decimal columns, not JS numbers — receive() calls .add() on currentStock.
      prisma.product.findUnique.mockResolvedValue({
        currentStock: new Prisma.Decimal(10),
        averageCost: new Prisma.Decimal(5),
      });

      await service.receive("ret-6", "user-1");

      expect(prisma.return.updateMany).toHaveBeenCalledWith({
        where: { id: "ret-6", status: { in: ["APPROVED", "IN_TRANSIT"] } },
        data: { status: "RECEIVED" },
      });
    });

    it("rejects a PENDING return before claiming", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-7",
        status: "PENDING",
        orderId: "ord-7",
        items: [],
      });

      await expect(service.receive("ret-7", "user-1")).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("{ restock: false } skips ALL restocking, persists restock:false on every item, and still reverses the regulated ledger", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-8",
        status: "IN_TRANSIT",
        orderId: "ord-8",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.receive("ret-8", "user-1", { restock: false });

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.returnItem.updateMany).toHaveBeenCalledWith({
        where: { returnId: "ret-8" },
        data: { restock: false },
      });
      expect(ledger.reverseReturnEntries).toHaveBeenCalledTimes(1);
    });
  });

  // ─── F08: B69 cancel() undo must key off the FRESH in-tx status/items ──────────────

  describe("cancel() (B69)", () => {
    it("REG-B69 cancel undoes on the FRESH in-tx status, not the stale outer read", async () => {
      const id = "ret-069";
      // The FRESH in-tx read: receive() won the race after cancel()'s outer read, so the
      // return is actually RECEIVED by the time the transaction locks the row.
      const txReturnFindUnique = jest.fn().mockResolvedValue({
        id,
        status: "RECEIVED",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });
      const tx = {
        return: {
          findUnique: txReturnFindUnique,
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        product: { update: jest.fn() },
        stockMovement: { deleteMany: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      // The STALE outer read: still APPROVED when cancel() first looked it up.
      prisma.return.findUnique.mockResolvedValue({
        id,
        status: "APPROVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });

      await service.cancel(id, { sub: "u1", role: "OPERATOR" } as any);

      expect(tx.product.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { currentStock: { decrement: 2 } },
      });
      expect(tx.stockMovement.deleteMany).toHaveBeenCalledWith({
        where: { productId: "p1", reference: `RET-${id.slice(0, 8)}` },
      });
      expect(ledger.unreverseReturnEntries).toHaveBeenCalledTimes(1);
      // The fresh read alone is still a TOCTOU: pin the FOR UPDATE row lock, and pin that
      // it ran BEFORE the fresh read, so deleting it turns this test red.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txReturnFindUnique.mock.invocationCallOrder[0],
      );
    });

    it("REG-B69 cancel honours restock:false left by receive(), read fresh in-tx", async () => {
      const id = "ret-069b";
      const txReturnFindUnique = jest.fn().mockResolvedValue({
        id,
        status: "RECEIVED",
        items: [{ productId: "p1", qty: 2, restock: false }],
      });
      const tx = {
        return: {
          findUnique: txReturnFindUnique,
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        product: { update: jest.fn() },
        stockMovement: { deleteMany: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      prisma.return.findUnique.mockResolvedValue({
        id,
        status: "APPROVED",
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2, restock: false }],
      });

      await service.cancel(id, { sub: "u1", role: "OPERATOR" } as any);

      expect(tx.product.update).not.toHaveBeenCalled(); // restock:false — nothing to decrement
      expect(tx.stockMovement.deleteMany).toHaveBeenCalledWith({
        where: { productId: "p1", reference: `RET-${id.slice(0, 8)}` },
      });
      expect(ledger.unreverseReturnEntries).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txReturnFindUnique.mock.invocationCallOrder[0],
      );
    });
  });
});
