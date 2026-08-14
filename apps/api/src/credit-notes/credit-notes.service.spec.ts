import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService — W5c regulated reversal", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseCreditNoteEntries: jest.Mock; unreverseCreditNoteEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = {
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-1", ...args.data, customer: {} }),
    );
  });

  const invoiceWith = (items: any[]) => ({ total: 100, customerId: "c1", items });

  it("reverses the ledger ONLY for an explicitly credited regulated line (line linkage)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 6 },
        { id: "ii-2", subtotal: 70, qty: 7, trackedCategoryId: null, categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    // Operator credits the regulated line in full ($30). The non-regulated line is untouched.
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 30,
      items: [{ invoiceItemId: "ii-1", amount: 30 }],
    });

    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1); // only the regulated line gets a CreditNoteItem
    expect(itemsData[0]).toMatchObject({
      creditNoteId: "cn-1",
      tenantId: "test-tenant",
      trackedCategoryId: "cat-A",
      amount: 30,
      qty: 3,
      categoryTax: 6,
    });
    expect(ledger.reverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
  });

  it("does NOT reverse the regulated ledger for a lump-sum credit with no line linkage", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({ customerId: "c1", invoiceId: "inv-1", amount: 40 }); // no items
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("crediting only a NON-regulated line never reverses regulated excise (no misattribution)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-reg", subtotal: 50, qty: 5, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
        { id: "ii-std", subtotal: 50, qty: 5, trackedCategoryId: null, categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 50,
      items: [{ invoiceItemId: "ii-std", amount: 50 }], // credit the candy, not the tobacco
    });
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("rejects line amounts that do not reconcile to the credit-note total", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 30,
        items: [{ invoiceItemId: "ii-1", amount: 20 }], // 20 != 30
      }),
    ).rejects.toThrow(/must sum to the credit note amount/);
  });

  it("rejects a credit line that is not on the source invoice", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 10,
        items: [{ invoiceItemId: "ii-nope", amount: 10 }],
      }),
    ).rejects.toThrow(/not on invoice/);
  });

  it("merges duplicate line references and REJECTS when the combined amount exceeds the line", async () => {
    // Two-line, $200 invoice so the header cap passes and the MERGED per-line cap is
    // what rejects the over-credit (the exact duplicate-invoiceItemId over-reversal vector).
    prisma.invoice.findUnique.mockResolvedValue({
      total: 200,
      customerId: "c1",
      items: [
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
        { id: "ii-2", subtotal: 100, qty: 10, trackedCategoryId: null, categoryTaxAmount: 0 },
      ],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 180, // 0 + 180 <= 200 header cap OK
        items: [
          { invoiceItemId: "ii-1", amount: 90 },
          { invoiceItemId: "ii-1", amount: 90 }, // merged 180 > line ii-1 subtotal 100
        ],
      }),
    ).rejects.toThrow(/exceeds invoice line subtotal/);
  });

  it("REJECTS a credit that exceeds a line's subtotal CUMULATIVELY across separate notes", async () => {
    // Two-line, $200 invoice: ii-1 already fully credited ($100) by an earlier note, ii-2
    // untouched. A new $100 credit of ii-1 passes the header cap ($100 prior + $100 = $200
    // ≤ $200, since ii-2's slack absorbs it) but must be rejected by the per-line cumulative
    // cap — otherwise ii-1 is credited $200 against a $100 subtotal (over-refund/over-reverse).
    prisma.invoice.findUnique.mockResolvedValue({
      total: 200,
      customerId: "c1",
      items: [
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
        { id: "ii-2", subtotal: 100, qty: 10, trackedCategoryId: null, categoryTaxAmount: 0 },
      ],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 100 } }); // header cap still has $100 headroom
    prisma.creditNoteItem.findMany.mockResolvedValue([{ invoiceItemId: "ii-1", amount: 100 }]); // ii-1 already fully credited
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 100,
        items: [{ invoiceItemId: "ii-1", amount: 100 }],
      }),
    ).rejects.toThrow(/plus prior credits.*would exceed invoice line subtotal/);
  });

  it("merges duplicate line references into a single CreditNoteItem when within the line", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 80,
      items: [
        { invoiceItemId: "ii-1", amount: 30 },
        { invoiceItemId: "ii-1", amount: 50 },
      ],
    });
    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1); // merged into one line
    expect(itemsData[0]).toMatchObject({ invoiceItemId: "ii-1", amount: 80, qty: 8 }); // 80/100 * 10
  });

  it("does NOT touch the ledger for a standalone credit note (no source invoice)", async () => {
    await service.create({ customerId: "c1", amount: 25 });
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("rejects a credit that would exceed the invoice total", async () => {
    prisma.invoice.findUnique.mockResolvedValue({ total: 100, customerId: "c1", items: [] });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 80 } }); // 80 already credited
    await expect(
      service.create({ customerId: "c1", invoiceId: "inv-1", amount: 30 }),
    ).rejects.toThrow(/exceed invoice total/);
  });

  it("voidCreditNote un-reverses the ledger for an unused (ISSUED) credit", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
    prisma.creditNote.updateMany.mockResolvedValue({ count: 1 }); // race-free flip succeeds
    await service.voidCreditNote("cn-1");
    expect(prisma.creditNote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cn-1", amountUsed: 0 }),
        data: { status: "VOID" },
      }),
    );
    expect(ledger.unreverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
  });

  it("refuses the void when a concurrent apply already consumed the credit (0 rows flipped)", async () => {
    // Guard read sees ISSUED/unused, but the race-free updateMany matches 0 rows.
    prisma.creditNote.findUnique.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
    prisma.creditNote.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.voidCreditNote("cn-1")).rejects.toThrow(/un-apply/i);
    expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("blocks voiding an APPLIED credit note (must un-apply first) — no ledger touch", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({ status: "APPLIED", amountUsed: 110 });
    await expect(service.voidCreditNote("cn-1")).rejects.toThrow(/un-apply/i);
    expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
  });
});

describe("CreditNotesService — P5-13 apply-math + auto-apply", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  it("applyToInvoice: partial apply is roundMoney'd, excludes VOID payments from the paid-sum, stays ISSUED, appliedAt stamped", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({
      id: "cn-p1",
      creditNoteNumber: "CN-2026-0010",
      amount: 100,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedAt: null,
      appliedToInvoiceId: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-p1",
      customerId: "c1",
      total: 1,
      dueDate: null,
      status: "SENT",
      payments: [
        { amount: 0.1, status: "PAID" },
        { amount: 0.2, status: "PAID" },
        // P5-12: a bounced check (VOID) must NOT count as paid.
        { amount: 999, status: "VOID" },
      ],
    });

    await service.applyToInvoice("cn-p1", "inv-p1");

    // alreadyPaid = roundMoney(0.1 + 0.2) = 0.3 (float-drift-safe), VOID excluded.
    // invoiceBalance = roundMoney(1 - 0.3) = 0.7; cnRemaining (100) is not the binding
    // constraint, so applyAmount clamps to the invoice balance.
    expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-p1",
          amount: 0.7,
          method: "CREDIT_NOTE",
          creditNoteId: "cn-p1",
        }),
      }),
    );

    const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
    expect(cnUpdate.data.amountUsed).toBe(0.7);
    expect(cnUpdate.data.status).toBe("ISSUED"); // 0.7 << 100 remaining, stays open
    expect(cnUpdate.data.appliedAt).toBeInstanceOf(Date);
    expect(cnUpdate.data.autoApplied).toBe(false); // manual apply, no opts.autoApplied
  });

  it("applyToInvoice: full exhaustion flips APPLIED + appliedToInvoiceId, invoice PAID", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({
      id: "cn-p2",
      creditNoteNumber: "CN-2026-0011",
      amount: 50,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedAt: null,
      appliedToInvoiceId: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-p2",
      customerId: "c1",
      total: 50,
      dueDate: null,
      status: "SENT",
      payments: [],
    });

    await service.applyToInvoice("cn-p2", "inv-p2");

    expect(prisma.creditNote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cn-p2" },
        data: expect.objectContaining({
          amountUsed: 50,
          status: "APPLIED",
          appliedToInvoiceId: "inv-p2",
        }),
      }),
    );
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inv-p2" },
        data: expect.objectContaining({ status: "PAID", paidAt: expect.any(Date) }),
      }),
    );
  });

  it("applyToInvoice: rejects an EXPIRED credit note before touching any money", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({
      id: "cn-p3",
      creditNoteNumber: "CN-2026-0012",
      amount: 40,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: new Date(Date.now() - 60_000), // expired a minute ago
      appliedToInvoiceId: null,
    });

    await expect(service.applyToInvoice("cn-p3", "inv-p3")).rejects.toThrow(/expired/i);
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.creditNote.update).not.toHaveBeenCalled();
  });

  it("autoApplyOldestCreditsInTx: applies oldest-first, clamps the 2nd credit to the remaining invoice balance, stamps autoApplied", async () => {
    const older = {
      id: "cn-a",
      creditNoteNumber: "CN-2026-0020",
      amount: 50,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedToInvoiceId: null,
      createdAt: new Date("2026-01-01"),
    };
    const newer = {
      id: "cn-b",
      creditNoteNumber: "CN-2026-0021",
      amount: 100,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedToInvoiceId: null,
      createdAt: new Date("2026-02-01"),
    };
    prisma.creditNote.findMany.mockResolvedValue([older, newer]); // pre-sorted by the query

    prisma.invoice.findUnique
      .mockResolvedValueOnce({
        id: "inv-a1",
        total: 120,
        dueDate: null,
        status: "SENT",
        payments: [],
      })
      .mockResolvedValueOnce({
        id: "inv-a1",
        total: 120,
        dueDate: null,
        status: "PARTIAL",
        payments: [{ amount: 50, status: "PAID" }],
      })
      .mockResolvedValueOnce({
        id: "inv-a1",
        total: 120,
        dueDate: null,
        status: "PAID",
        payments: [
          { amount: 50, status: "PAID" },
          { amount: 70, status: "PAID" },
        ],
      });

    const result = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-a1", "c1");

    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    );
    expect(result).toEqual({ applied: 120, invoiceStatus: "PAID" });

    // 1st credit (older, $50) is fully consumed.
    expect(prisma.invoicePayment.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ creditNoteId: "cn-a", amount: 50 }),
      }),
    );
    // 2nd credit (newer, $100 of its own remaining) is clamped to the $70 left on the
    // invoice — the running-balance hard clamp, not the credit's own remaining.
    expect(prisma.invoicePayment.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ creditNoteId: "cn-b", amount: 70 }),
      }),
    );

    const cnAUpdate = prisma.creditNote.update.mock.calls.find(
      (c: any) => c[0].where.id === "cn-a",
    )![0];
    expect(cnAUpdate.data).toMatchObject({ status: "APPLIED", autoApplied: true, amountUsed: 50 });
    const cnBUpdate = prisma.creditNote.update.mock.calls.find(
      (c: any) => c[0].where.id === "cn-b",
    )![0];
    expect(cnBUpdate.data).toMatchObject({ status: "ISSUED", autoApplied: true, amountUsed: 70 });
  });

  it("autoApplyOldestCreditsInTx: skips an exhausted credit (JS remaining filter) and asserts the where.OR expiry predicate", async () => {
    const exhausted = {
      id: "cn-x",
      creditNoteNumber: "CN-2026-0030",
      amount: 30,
      amountUsed: 30, // remaining 0 — must NOT apply
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedToInvoiceId: null,
      createdAt: new Date("2026-01-01"),
    };
    const open = {
      id: "cn-y",
      creditNoteNumber: "CN-2026-0031",
      amount: 50,
      amountUsed: 0,
      status: "ISSUED",
      customerId: "c1",
      expiresAt: null,
      appliedToInvoiceId: null,
      createdAt: new Date("2026-02-01"),
    };
    prisma.creditNote.findMany.mockResolvedValue([exhausted, open]);
    prisma.invoice.findUnique
      .mockResolvedValueOnce({
        id: "inv-a2",
        total: 50,
        dueDate: null,
        status: "SENT",
        payments: [],
      })
      .mockResolvedValueOnce({
        id: "inv-a2",
        total: 50,
        dueDate: null,
        status: "PAID",
        payments: [{ amount: 50, status: "PAID" }],
      });

    const result = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-a2", "c1");

    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: "c1",
          status: { not: "VOID" },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
    expect(result).toEqual({ applied: 50, invoiceStatus: "PAID" });
    expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ creditNoteId: "cn-y" }) }),
    );
    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cn-x" } }),
    );
  });

  it("autoApplyOldestCreditsInTx: a PAID invoice is idempotent on re-send — credits are never even fetched", async () => {
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-a3",
      total: 100,
      dueDate: null,
      status: "PAID",
      payments: [{ amount: 100, status: "PAID" }],
    });

    const result = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-a3", "c1");

    expect(result).toEqual({ applied: 0, invoiceStatus: null });
    expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("autoApplyOldestCreditsInTx: threads opts.excludeCreditNoteIds into the candidate query so an operator's explicit-amount order selection is not overridden by the sweep", async () => {
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-a4",
      total: 50,
      dueDate: null,
      status: "SENT",
      payments: [],
    });
    prisma.creditNote.findMany.mockResolvedValueOnce([]); // excluded id filtered server-side

    const result = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-a4", "c1", {
      excludeCreditNoteIds: ["cn-explicit"],
    });

    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ["cn-explicit"] } }),
      }),
    );
    expect(result).toEqual({ applied: 0, invoiceStatus: null });
  });

  it("autoApplyOldestCreditsInTx: an empty excludeCreditNoteIds does not add an id filter", async () => {
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-a5",
      total: 50,
      dueDate: null,
      status: "SENT",
      payments: [],
    });
    prisma.creditNote.findMany.mockResolvedValueOnce([]);

    await service.autoApplyOldestCreditsInTx(prisma as any, "inv-a5", "c1", {
      excludeCreditNoteIds: [],
    });

    const where = prisma.creditNote.findMany.mock.calls[0][0].where;
    expect(where.id).toBeUndefined();
  });
});

describe("CreditNotesService — order credit-note intents (unapply / settle / validate / update)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  describe("releaseOrderCreditsInTx (cancel / delete unwind)", () => {
    it("restores every applied credit on the order and forgets the intents", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        { id: "pay-a", invoiceId: "inv-1", creditNoteId: "cn-1", amount: 30, status: "PAID" },
        { id: "pay-b", invoiceId: "inv-2", creditNoteId: "cn-1", amount: 20, status: "PAID" },
      ]);
      // restoreCreditFromPaymentInTx reads the note then the invoice, per payment.
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-1",
          amount: 100,
          amountUsed: 50,
          status: "ISSUED",
          appliedToInvoiceId: null,
        })
        .mockResolvedValueOnce({ creditNoteNumber: "CN-1" })
        .mockResolvedValueOnce({
          id: "cn-1",
          amount: 100,
          amountUsed: 20,
          status: "ISSUED",
          appliedToInvoiceId: null,
        });
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          id: "inv-1",
          total: 30,
          dueDate: null,
          status: "PAID",
          payments: [],
        })
        .mockResolvedValueOnce({
          id: "inv-2",
          total: 20,
          dueDate: null,
          status: "PAID",
          payments: [],
        });

      const released = await service.releaseOrderCreditsInTx(prisma as any, "order-1");

      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-a" } });
      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-b" } });
      // Both applications roll up under the one note that made them.
      expect(released).toEqual([{ creditNoteId: "cn-1", creditNoteNumber: "CN-1", amount: 50 }]);
      // Intents must go, or the next settle re-applies what we just gave back.
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { orderId: "order-1" },
      });
    });

    it("sweeps credits off invoices that are ALREADY void — the stranded-money case", async () => {
      // settleOrderCreditsInTx filters VOID invoices out, so before this existed a
      // credit applied to a since-voided invoice could never be recovered.
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        { id: "pay-v", invoiceId: "inv-void", creditNoteId: "cn-9", amount: 25, status: "PAID" },
      ]);
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-9",
          amount: 25,
          amountUsed: 25,
          status: "APPLIED",
          appliedToInvoiceId: "inv-void",
        })
        .mockResolvedValueOnce({ creditNoteNumber: "CN-9" });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-void",
        total: 25,
        dueDate: null,
        status: "VOID",
        payments: [],
      });

      const released = await service.releaseOrderCreditsInTx(prisma as any, "order-9");

      // The query must NOT constrain invoice status — that filter is the bug.
      const where = prisma.invoicePayment.findMany.mock.calls[0][0].where;
      expect(where.invoice).toEqual({ orderId: "order-9" });
      expect(released[0]).toMatchObject({ creditNoteId: "cn-9", amount: 25 });
      expect(prisma.creditNote.update.mock.calls[0][0].data).toMatchObject({
        amountUsed: 0,
        status: "ISSUED",
      });
    });

    it("revives a note that expired while its money sat on the invoice", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        { id: "pay-x", invoiceId: "inv-x", creditNoteId: "cn-x", amount: 15, status: "PAID" },
      ]);
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-x",
          amount: 15,
          amountUsed: 15,
          status: "APPLIED",
          appliedToInvoiceId: "inv-x",
          expiresAt: new Date("2020-01-01"), // long past
        })
        .mockResolvedValueOnce({ creditNoteNumber: "CN-X" });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-x",
        total: 15,
        dueDate: null,
        status: "PAID",
        payments: [],
      });

      await service.releaseOrderCreditsInTx(prisma as any, "order-x");

      // Money handed back to an expired note would be invisible to every "open
      // credit" reader — clearing the stale expiry keeps it spendable.
      expect(prisma.creditNote.update.mock.calls[0][0].data).toMatchObject({
        amountUsed: 0,
        status: "ISSUED",
        expiresAt: null,
      });
    });

    it("leaves a FUTURE expiry alone — that note is still validly dated", async () => {
      const future = new Date(Date.now() + 90 * 24 * 3600 * 1000);
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        { id: "pay-f", invoiceId: "inv-f", creditNoteId: "cn-f", amount: 10, status: "PAID" },
      ]);
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-f",
          amount: 10,
          amountUsed: 10,
          status: "APPLIED",
          appliedToInvoiceId: "inv-f",
          expiresAt: future,
        })
        .mockResolvedValueOnce({ creditNoteNumber: "CN-F" });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-f",
        total: 10,
        dueDate: null,
        status: "PAID",
        payments: [],
      });

      await service.releaseOrderCreditsInTx(prisma as any, "order-f");

      expect(prisma.creditNote.update.mock.calls[0][0].data.expiresAt).toBeUndefined();
    });

    it("is a no-op when the order never had a credit applied", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([]);

      const released = await service.releaseOrderCreditsInTx(prisma as any, "order-none");

      expect(released).toEqual([]);
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
    });
  });

  describe("previewOrderCreditRelease", () => {
    it("totals per note WITHOUT moving any money", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "p1",
          creditNoteId: "cn-1",
          amount: 30,
          status: "PAID",
          creditNote: { creditNoteNumber: "CN-1" },
        },
        {
          id: "p2",
          creditNoteId: "cn-1",
          amount: 20,
          status: "PAID",
          creditNote: { creditNoteNumber: "CN-1" },
        },
        {
          id: "p3",
          creditNoteId: "cn-2",
          amount: 5,
          status: "PAID",
          creditNote: { creditNoteNumber: "CN-2" },
        },
      ]);

      const preview = await service.previewOrderCreditRelease("order-1");

      expect(preview).toEqual([
        { creditNoteId: "cn-1", creditNoteNumber: "CN-1", amount: 50 },
        { creditNoteId: "cn-2", creditNoteNumber: "CN-2", amount: 5 },
      ]);
      expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
    });
  });

  describe("unapplyFromInvoice", () => {
    it("restores amountUsed, flips APPLIED→ISSUED, and clears appliedToInvoiceId", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "pay-1",
          invoiceId: "inv-1",
          creditNoteId: "cn-1",
          amount: 40,
          status: "PAID",
          createdAt: new Date("2026-01-02"),
        },
      ]);
      // 1st creditNote.findUnique: inside restoreCreditFromPaymentInTx (fetch to update).
      // 2nd: the final fresh-row read at the end of unapplyFromInvoice.
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-1",
          amount: 40,
          amountUsed: 40,
          status: "APPLIED",
          appliedToInvoiceId: "inv-1",
        })
        .mockResolvedValueOnce({ id: "cn-1", amount: 40, amountUsed: 0, status: "ISSUED" });
      // 1st invoice.findUnique: inside restoreCreditFromPaymentInTx (recompute status).
      // 2nd: unapplyFromInvoice's own orderId lookup.
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          id: "inv-1",
          total: 100,
          dueDate: null,
          status: "PAID",
          payments: [],
        })
        .mockResolvedValueOnce({ orderId: null });

      const result = await service.unapplyFromInvoice("cn-1", "inv-1");

      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
      const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
      expect(cnUpdate.data).toMatchObject({
        amountUsed: 0,
        status: "ISSUED",
        appliedToInvoiceId: null,
      });
      expect(result).toMatchObject({ id: "cn-1", amountUsed: 0, status: "ISSUED" });
    });

    it("on a credit partially consumed by ANOTHER invoice, restores only this pair's dollars", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "pay-2",
          invoiceId: "inv-2",
          creditNoteId: "cn-2",
          amount: 40,
          status: "PAID",
          createdAt: new Date("2026-01-05"),
        },
      ]);
      // amountUsed=70 reflects $40 on THIS invoice + $30 already consumed elsewhere.
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-2",
          amount: 100,
          amountUsed: 70,
          status: "ISSUED",
          appliedToInvoiceId: null,
        })
        .mockResolvedValueOnce({ id: "cn-2", amount: 100, amountUsed: 30, status: "ISSUED" });
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          id: "inv-2",
          total: 50,
          dueDate: null,
          status: "PARTIAL",
          payments: [],
        })
        .mockResolvedValueOnce({ orderId: null });

      await service.unapplyFromInvoice("cn-2", "inv-2");

      const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
      // 70 - 40 = 30: the OTHER invoice's $30 consumption is untouched.
      expect(cnUpdate.data.amountUsed).toBe(30);
      expect(cnUpdate.data.status).toBe("ISSUED");
    });

    it("throws when there is no active application of this credit to this invoice", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([]);
      await expect(service.unapplyFromInvoice("cn-3", "inv-3")).rejects.toThrow(
        /no active application/i,
      );
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
    });

    it("reduces the order intent so a later settle doesn't just re-apply the restored dollars", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "pay-4",
          invoiceId: "inv-4",
          creditNoteId: "cn-4",
          amount: 25,
          status: "PAID",
          createdAt: new Date("2026-01-06"),
        },
      ]);
      prisma.creditNote.findUnique
        .mockResolvedValueOnce({
          id: "cn-4",
          amount: 100,
          amountUsed: 25,
          status: "ISSUED",
          appliedToInvoiceId: null,
        })
        .mockResolvedValueOnce({ id: "cn-4", amount: 100, amountUsed: 0, status: "ISSUED" });
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          id: "inv-4",
          total: 25,
          dueDate: null,
          status: "SENT",
          payments: [],
        })
        .mockResolvedValueOnce({ orderId: "order-4" });
      prisma.orderCreditNote.findFirst.mockResolvedValueOnce({
        id: "ocn-4",
        orderId: "order-4",
        creditNoteId: "cn-4",
        amount: 25, // explicit $25 request, fully restored — should be removed
      });

      await service.unapplyFromInvoice("cn-4", "inv-4");

      expect(prisma.orderCreditNote.delete).toHaveBeenCalledWith({ where: { id: "ocn-4" } });
    });
  });

  describe("settleOrderCreditsInTx", () => {
    it("applies a stored (null-amount) intent once an invoice exists; a second call is idempotent (applies 0)", async () => {
      const baseIntent = {
        id: "ocn-1",
        orderId: "order-1",
        creditNoteId: "cn-3",
        amount: null,
        createdAt: new Date("2026-01-01"),
      };
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        {
          ...baseIntent,
          creditNote: { id: "cn-3", amount: 50, amountUsed: 0, status: "ISSUED", expiresAt: null },
        },
      ]);
      prisma.invoice.findMany.mockResolvedValueOnce([
        {
          id: "inv-3",
          invoiceNumber: "INV-0001",
          total: 100,
          dueDate: null,
          status: "SENT",
          payments: [],
        },
      ]);
      prisma.creditNote.findUnique.mockResolvedValueOnce({
        id: "cn-3",
        amount: 50,
        amountUsed: 0,
        status: "ISSUED",
        appliedToInvoiceId: null,
        appliedAt: null,
        autoApplied: false,
      });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-3",
        total: 100,
        dueDate: null,
        status: "SENT",
        payments: [],
      });

      const first = await service.settleOrderCreditsInTx(prisma as any, "order-1");
      expect(first).toEqual({ applied: 50, unapplied: 0 });

      // Re-mock as if the first apply had actually persisted: the invoice now carries
      // the $50 CREDIT_NOTE payment and the credit is fully consumed — a re-run
      // must be a no-op (idempotent).
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        {
          ...baseIntent,
          creditNote: {
            id: "cn-3",
            amount: 50,
            amountUsed: 50,
            status: "APPLIED",
            expiresAt: null,
          },
        },
      ]);
      prisma.invoice.findMany.mockResolvedValueOnce([
        {
          id: "inv-3",
          invoiceNumber: "INV-0001",
          total: 100,
          dueDate: null,
          status: "PARTIAL",
          payments: [
            {
              id: "pay-3",
              amount: 50,
              status: "PAID",
              method: "CREDIT_NOTE",
              creditNoteId: "cn-3",
              createdAt: new Date(),
            },
          ],
        },
      ]);

      const second = await service.settleOrderCreditsInTx(prisma as any, "order-1");
      expect(second).toEqual({ applied: 0, unapplied: 0 });
    });

    it("shrink pass: an invoice total dropped below Σ payments reduces the credit payment and decrements amountUsed; cash is untouched", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([]); // no apply-phase intents needed
      prisma.invoice.findMany.mockResolvedValueOnce([
        {
          id: "inv-4",
          invoiceNumber: "INV-0002",
          total: 60, // shrunk from 100
          dueDate: null,
          status: "PARTIAL",
          payments: [
            {
              id: "pay-cash",
              amount: 40,
              status: "PAID",
              method: "CASH",
              creditNoteId: null,
              createdAt: new Date("2026-01-01"),
            },
            {
              id: "pay-credit",
              amount: 60,
              status: "PAID",
              method: "CREDIT_NOTE",
              creditNoteId: "cn-4",
              createdAt: new Date("2026-01-02"),
            },
          ],
        },
      ]);
      prisma.creditNote.findUnique.mockResolvedValueOnce({
        id: "cn-4",
        amount: 100,
        amountUsed: 60,
        status: "ISSUED",
        appliedToInvoiceId: null,
      });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-4",
        total: 60,
        dueDate: null,
        status: "PARTIAL",
        payments: [
          { amount: 40, status: "PAID" },
          { amount: 20, status: "PAID" },
        ],
      });

      const result = await service.settleOrderCreditsInTx(prisma as any, "order-4");

      expect(result.unapplied).toBe(40);
      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
        where: { id: "pay-credit" },
        data: { amount: 20 },
      });
      expect(prisma.invoicePayment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "pay-cash" } }),
      );
      expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
      const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
      expect(cnUpdate.data.amountUsed).toBe(20);
    });

    it("explicit-amount intent applies exactly min(requested amount, credit remaining, invoice balance)", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        {
          id: "ocn-2",
          orderId: "order-5",
          creditNoteId: "cn-5",
          amount: 30, // operator requested $30
          createdAt: new Date("2026-01-01"),
          creditNote: {
            id: "cn-5",
            amount: 100,
            amountUsed: 80,
            status: "ISSUED",
            expiresAt: null,
          }, // $20 remaining
        },
      ]);
      prisma.invoice.findMany.mockResolvedValueOnce([
        {
          id: "inv-5",
          invoiceNumber: "INV-0003",
          total: 50,
          dueDate: null,
          status: "SENT",
          payments: [],
        },
      ]);
      prisma.creditNote.findUnique.mockResolvedValueOnce({
        id: "cn-5",
        amount: 100,
        amountUsed: 80,
        status: "ISSUED",
        appliedToInvoiceId: null,
        appliedAt: null,
        autoApplied: false,
      });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-5",
        total: 50,
        dueDate: null,
        status: "SENT",
        payments: [],
      });

      const result = await service.settleOrderCreditsInTx(prisma as any, "order-5");

      expect(result.applied).toBe(20); // min(30 requested, 20 remaining, 50 balance)
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 20, creditNoteId: "cn-5" }),
        }),
      );
    });

    it("is a no-op when the order has no non-VOID invoices yet", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        {
          id: "ocn-9",
          orderId: "order-9",
          creditNoteId: "cn-9",
          amount: null,
          createdAt: new Date(),
        },
      ]);
      prisma.invoice.findMany.mockResolvedValueOnce([]);

      const result = await service.settleOrderCreditsInTx(prisma as any, "order-9");

      expect(result).toEqual({ applied: 0, unapplied: 0 });
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });
  });

  describe("validateSelectionsForCustomer", () => {
    it("rejects a duplicate creditNoteId in the selection list", async () => {
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [
          { creditNoteId: "cn-1" },
          { creditNoteId: "cn-1" },
        ]),
      ).rejects.toThrow(/duplicate/i);
    });

    it("rejects an unknown credit note id", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([]);
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [
          { creditNoteId: "cn-missing" },
        ]),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects a credit note belonging to a different customer", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([
        { id: "cn-1", customerId: "other-customer", status: "ISSUED", expiresAt: null },
      ]);
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [{ creditNoteId: "cn-1" }]),
      ).rejects.toThrow(/customer/i);
    });

    it("rejects a VOID credit note", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([
        { id: "cn-1", customerId: "c1", status: "VOID", expiresAt: null },
      ]);
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [{ creditNoteId: "cn-1" }]),
      ).rejects.toThrow(/voided/i);
    });

    it("rejects an expired credit note", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([
        {
          id: "cn-1",
          customerId: "c1",
          status: "ISSUED",
          expiresAt: new Date(Date.now() - 60_000),
        },
      ]);
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [{ creditNoteId: "cn-1" }]),
      ).rejects.toThrow(/expired/i);
    });

    it("ACCEPTS a fully-consumed selection (idempotent resubmit) — no remaining-balance check", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([
        {
          id: "cn-1",
          customerId: "c1",
          status: "APPLIED",
          amount: 50,
          amountUsed: 50,
          expiresAt: null,
        },
      ]);
      await expect(
        service.validateSelectionsForCustomer(prisma as any, "c1", [
          { creditNoteId: "cn-1", amount: 50 },
        ]),
      ).resolves.toBeUndefined();
    });

    it("is a no-op for an empty selection list (no query issued)", async () => {
      await service.validateSelectionsForCustomer(prisma as any, "c1", []);
      expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
    });
  });

  describe("syncOrderCreditSelections", () => {
    it("undefined selections leaves credits untouched (no reads or writes)", async () => {
      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", undefined);
      expect(prisma.orderCreditNote.findMany).not.toHaveBeenCalled();
    });

    it("creates a new OrderCreditNote row for a newly selected credit not previously stored", async () => {
      prisma.creditNote.findMany.mockResolvedValueOnce([
        { id: "cn-1", customerId: "c1", status: "ISSUED", expiresAt: null },
      ]);
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([]); // nothing stored yet

      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", [
        { creditNoteId: "cn-1", amount: 20 },
      ]);

      expect(prisma.orderCreditNote.create).toHaveBeenCalledWith({
        data: { orderId: "order-1", creditNoteId: "cn-1", amount: 20, tenantId: "test-tenant" },
      });
    });

    it("drops a de-selected credit: pulls back its money then deletes the row", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        { id: "ocn-1", orderId: "order-1", creditNoteId: "cn-1", amount: null },
      ]);
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "pay-1",
          invoiceId: "inv-1",
          creditNoteId: "cn-1",
          amount: 15,
          status: "PAID",
          createdAt: new Date(),
        },
      ]);
      prisma.creditNote.findUnique.mockResolvedValueOnce({
        id: "cn-1",
        amount: 15,
        amountUsed: 15,
        status: "APPLIED",
        appliedToInvoiceId: "inv-1",
      });
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "inv-1",
        total: 15,
        dueDate: null,
        status: "PAID",
        payments: [],
      });

      // Selection list is now empty — cn-1 was de-selected.
      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", []);

      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
      expect(prisma.orderCreditNote.delete).toHaveBeenCalledWith({ where: { id: "ocn-1" } });
      expect(prisma.orderCreditNote.create).not.toHaveBeenCalled();
    });
  });

  describe("updateCreditNote", () => {
    it("edits the reason at ANY status (e.g. APPLIED)", async () => {
      prisma.creditNote.findUnique.mockResolvedValueOnce({ id: "cn-1", status: "APPLIED" });
      prisma.creditNote.update.mockResolvedValueOnce({ id: "cn-1", reason: "updated reason" });

      const result = await service.updateCreditNote("cn-1", { reason: "updated reason" });

      expect(prisma.creditNote.update).toHaveBeenCalledWith({
        where: { id: "cn-1" },
        data: { reason: "updated reason" },
      });
      expect(result).toMatchObject({ reason: "updated reason" });
    });

    it("rejects an expiresAt edit when the credit note is not ISSUED", async () => {
      prisma.creditNote.findUnique.mockResolvedValueOnce({ id: "cn-1", status: "APPLIED" });
      await expect(service.updateCreditNote("cn-1", { expiresAt: "2030-01-01" })).rejects.toThrow(
        /ISSUED/,
      );
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
    });

    it("allows an expiresAt edit while ISSUED", async () => {
      prisma.creditNote.findUnique.mockResolvedValueOnce({ id: "cn-1", status: "ISSUED" });
      await service.updateCreditNote("cn-1", { expiresAt: "2030-01-01" });
      expect(prisma.creditNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cn-1" },
          data: expect.objectContaining({ expiresAt: expect.any(Date) }),
        }),
      );
    });

    it("throws NotFound for an unknown credit note id", async () => {
      prisma.creditNote.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateCreditNote("cn-missing", { reason: "x" })).rejects.toThrow(
        /not found/i,
      );
    });
  });
});
