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
});
