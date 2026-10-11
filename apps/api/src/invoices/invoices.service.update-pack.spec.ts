/**
 * SA-068: update()'s pack comes from the PAYLOAD's own split, never the live
 * product. The edit page already sends boxes/pieces/qty consistent with the
 * line's OWN snapshot (or, for a brand-new line, the live pack it read at page
 * load) — re-normalizing at TODAY's live pack silently re-split a stored line
 * if the product had since been repacked, corrupting qty. The corrupted qty
 * then back-synced onto the linked order line via recomputeOrderFromInvoices,
 * which is unchanged by this fix (it already prefers a line's own snapshot
 * over the live product — see its own
 * `existing?.unitsPerBox ?? agg.sample?.unitsPerBox` — so a correctly-written
 * InvoiceItem here is sufficient; not retested here).
 *
 * A dedicated file rather than an addition to invoices.service.spec.ts: that
 * file sits exactly at its size-ratchet ceiling (common/size-ratchet.spec.ts),
 * which explicitly asks new code to move to its own module instead of raising
 * the baseline.
 */

// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService.update() — SA-068 pack comes from the payload, never the live product", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
    reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draftInvoice = {
    id: "inv-box",
    orderId: null,
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 0,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 0,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };

  it("(a) a stored 2-box/3-piece line (snapshot 12, qty 27) on a notes-only save stays 27/2/3/12 even though the product is now pack-24, and warns", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 24 }]); // repacked
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    // The edit page sends the split consistent with the line's OWN stored snapshot
    // (12), not the live product (24) — this is what today's code discards.
    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 27,
          unitPrice: 28.35,
          boxes: 2,
          pieces: 3,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.qty).toBe(27);
    expect(created.boxes).toBe(2);
    expect(created.pieces).toBe(3);
    expect(created.unitsPerBox).toBe(12); // NOT 24 — the payload's own implied pack
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("prod-box");
    expect(warn.mock.calls[0][0]).toContain("12");
    expect(warn.mock.calls[0][0]).toContain("24");
    warn.mockRestore();
  });

  it("(b) a legacy split with no snapshot derives its pack from the payload's own split (12), not the live product", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]); // agrees
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 27,
          unitPrice: 28.35,
          boxes: 2,
          pieces: 3,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.unitsPerBox).toBe(12);
    expect(warn).not.toHaveBeenCalled(); // live agrees with the derived pack — nothing to warn about
    warn.mockRestore();
  });

  it("(c) B717/SA-077c: a contradictory split prices FROM THE SPLIT at the live pack, qty stored AS SENT", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([]); // no stored line to carry
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    // (10 - 2) / 3 = 2.667 — the payload's split cannot imply a pack. This used to store a null
    // pack and price 10 loose pieces at the BOX price.
    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 10,
          unitPrice: 11,
          boxes: 3,
          pieces: 2,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    // qty is stored AS SENT — never recomputed as boxes * pack + pieces, because that value
    // back-syncs onto the linked OrderItem (recomputeOrderFromInvoices :2347) and would rewrite
    // an order quantity nobody edited. KNOWN RESIDUAL: 10 != 3 * 12 + 2, so this row under-files
    // on the ledger's piece axis; bounded, warned, and closed by the SA-077(2) refusal.
    expect(created.subtotal).toBeCloseTo(34.83, 2); // 11 * (3 + 2/12), never 11 * 10
    expect(created.qty).toBe(10);
    expect(created.boxes).toBe(3);
    expect(created.pieces).toBe(2);
    expect(created.unitsPerBox).toBe(12); // the resolved pack is snapshotted
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("(e) B717: a sub-one-box split ({qty 5, boxes 0, pieces 5}) prorates at the line's pack, never box-price-per-piece", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "item-1", productId: "prod-box", unitsPerBox: 12 },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);

    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 5,
          unitPrice: 11, // the CASE price
          boxes: 0,
          pieces: 5,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.qty).toBe(5);
    expect(created.boxes).toBe(0);
    expect(created.pieces).toBe(5);
    // 11 * (0 + 5/12) = 4.583... -> 4.58. NOT 11 * 5 = 55.00.
    expect(created.subtotal).toBeCloseTo(4.58, 2);
    expect(created.unitsPerBox).toBe(12);
  });

  it("(f) B717: a sub-one-box split falls back to the LIVE pack when no stored snapshot exists", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([]); // legacy row, no snapshot
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 13,
          unitPrice: 11,
          boxes: 0,
          pieces: 13,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    // 11 * 13/12 = 11.9166... -> 11.92. NOT 11 * 13 = 143.00.
    expect(created.subtotal).toBeCloseTo(11.92, 2);
    expect(created.unitsPerBox).toBe(12);
    // SA-077: pricing at the live pack is new-line semantics and says so out loud.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("new-line semantics");
    warn.mockRestore();
  });

  it("(h) SA-184: a NEW line never inherits a SIBLING's pack (two stored lines at 12 do not carry onto it): live pack applies, the siblings are untouched", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    const sibling = (id: string) => ({
      id,
      productId: "prod-box",
      description: "Boxed chips",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitPrice: 11,
      discount: 0,
      subtotal: 22,
      unitsPerBox: 12,
    });
    prisma.invoiceItem.findMany.mockResolvedValue([sibling("item-1"), sibling("item-2")]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]); // live differs
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.update.mockResolvedValue({});

    await service.update("inv-box", {
      items: [
        {
          id: "item-1",
          productId: "prod-box",
          description: "Boxed chips",
          qty: 24,
          unitPrice: 11,
          boxes: 2,
          pieces: 0,
        },
        {
          id: "item-2",
          productId: "prod-box",
          description: "Boxed chips",
          qty: 24,
          unitPrice: 11,
          boxes: 2,
          pieces: 0,
        },
        {
          productId: "prod-box",
          description: "New line",
          qty: 3,
          unitPrice: 11,
          boxes: 0,
          pieces: 3,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create;
    expect(created).toHaveLength(1); // only the new line is created; the two siblings stay in place
    expect(created[0].unitsPerBox).toBe(6); // live (new-line semantics), NOT the siblings' 12
    expect(created[0].subtotal).toBeCloseTo(5.5, 2); // 11 * 3/6
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled(); // siblings preserved verbatim
  });

  it("(h2) B717/SA-077b: stored lines that DISAGREE carry nothing; the live pack applies, with a warn", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "item-1", productId: "prod-box", unitsPerBox: 12 },
      { id: "item-2", productId: "prod-box", unitsPerBox: 24 },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 3,
          unitPrice: 11,
          boxes: 0,
          pieces: 3,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.unitsPerBox).toBe(6); // live, because the stored packs disagree
    expect(created.subtotal).toBeCloseTo(5.5, 2); // 11 * 3/6
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("(g) B717/SA-184: a save that changes no money leaves the stored line verbatim, pack snapshot included", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    // A box-unaware line that nonetheless carries a sale-time snapshot (order-derived).
    prisma.invoiceItem.findMany.mockResolvedValue([
      {
        id: "item-1",
        productId: "prod-box",
        description: "Boxed chips",
        qty: 5,
        boxes: null,
        pieces: null,
        unitPrice: 11,
        discount: 0,
        subtotal: 55,
        unitsPerBox: 12,
      },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 24 }]); // repacked since
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.update.mockResolvedValue({});

    await service.update("inv-box", {
      items: [
        { id: "item-1", productId: "prod-box", description: "Boxed chips", qty: 5, unitPrice: 11 },
      ],
    });

    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data.items.create).toEqual([]); // matched, kept in place
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled(); // nothing to write
    expect(data.subtotal).toBeCloseTo(55, 2); // the stored money, untouched
  });

  it("(g2) B717/SA-184: a CHANGED no-split line keeps its OWN stored pack (12), never the live 24 or a sibling's", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([
      {
        id: "item-1",
        productId: "prod-box",
        description: "Boxed chips",
        qty: 5,
        boxes: null,
        pieces: null,
        unitPrice: 11,
        discount: 0,
        subtotal: 55,
        unitsPerBox: 12,
      },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 24 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.update.mockResolvedValue({});

    await service.update("inv-box", {
      items: [
        { id: "item-1", productId: "prod-box", description: "Boxed chips", qty: 6, unitPrice: 11 },
      ],
    });

    expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: expect.objectContaining({ qty: 6, unitsPerBox: 12, subtotal: 66 }),
    });
  });

  // packFromOwnSplit returns null THREE ways, and all three left the pack undefined and priced
  // loose pieces at the BOX price. (e)/(f) cover path 1 (no boxes). These cover the other two on a
  // line that HAS a stored snapshot — carrying its own pack forward is not guessing one.

  it("(i) B717 path 2 (non-integer quotient): a stored snapshot is carried, not destroyed", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "item-1", productId: "prod-box", unitsPerBox: 12 },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);

    // (50 - 3) / 2 = 23.5 — not an integer, so packFromOwnSplit refuses it.
    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 50,
          unitPrice: 11,
          boxes: 2,
          pieces: 3,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.unitsPerBox).toBe(12); // carried, not nulled
    expect(created.subtotal).toBeCloseTo(24.75, 2); // 11 * (2 + 3/12), not 11 * 50
  });

  it("(j) B717 path 3 (quotient of exactly 1): a stored snapshot is carried, not destroyed", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "item-1", productId: "prod-box", unitsPerBox: 12 },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);

    // (7 - 2) / 5 = 1 — a "pack of one" is indistinguishable from unboxed, so it is refused.
    await service.update("inv-box", {
      items: [
        {
          productId: "prod-box",
          description: "Boxed chips",
          qty: 7,
          unitPrice: 11,
          boxes: 5,
          pieces: 2,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.unitsPerBox).toBe(12);
    expect(created.subtotal).toBeCloseTo(56.83, 2); // 11 * (5 + 2/12), not 11 * 7
  });

  // ─── SA-077(2): a split with no pack anywhere is REFUSED rather than silently dropped ───

  it("(k) SA-077(2): update() refuses a split when no pack resolves anywhere, naming the line", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([]); // nothing stored to carry
    prisma.product.findMany.mockResolvedValue([{ id: "prod-flat", unitsPerBox: null }]); // unboxed
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);

    await expect(
      service.update("inv-box", {
        items: [
          {
            productId: "prod-flat",
            description: "Flat widget",
            // Deliberately NOT self-consistent: (10 - 2) / 3 = 2.667, so the payload implies no
            // pack either. {qty 60, boxes 5, pieces 0} would NOT reach this guard — its own split
            // implies 12, which resolves and prices correctly (that is B717's path, not this one).
            qty: 10,
            unitPrice: 11,
            boxes: 3,
            pieces: 2,
          },
        ],
      }),
    ).rejects.toThrow(/Flat widget/);
    expect(prisma.invoice.update).not.toHaveBeenCalled(); // nothing written
  });

  it("(l) SA-077(2): a pack of exactly 1 is not a pack, so the split is refused too (cf. B664)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-flat", unitsPerBox: 1 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);

    await expect(
      service.update("inv-box", {
        items: [
          {
            productId: "prod-flat",
            description: "Flat widget",
            qty: 6,
            unitPrice: 11,
            boxes: 6,
            pieces: 0,
          },
        ],
      }),
    ).rejects.toThrow(/no pack/);
  });

  it("(d) a brand-new split line on a pack-24 product snapshots 24 (the payload's own implied pack)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.product.findMany.mockResolvedValue([{ id: "prod-new", unitsPerBox: 24 }]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    // A new line has no prior snapshot; the edit page read the live pack (24) at
    // page load and sent a split consistent with it.
    await service.update("inv-box", {
      items: [
        {
          productId: "prod-new",
          description: "New boxed line",
          qty: 50, // 2 boxes * 24 + 2 pieces
          unitPrice: 40,
          boxes: 2,
          pieces: 2,
        },
      ],
    });

    const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(created.unitsPerBox).toBe(24);
    expect(warn).not.toHaveBeenCalled(); // derived pack (24) agrees with the live product
    warn.mockRestore();
  });
});
