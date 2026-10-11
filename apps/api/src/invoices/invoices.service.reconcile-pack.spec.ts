/**
 * SA-078(b) (Senior Architect ruling 2026-09-22, on top of B700/#1237). B700 made
 * `toSaleLedgerLines` prefer an InvoiceItem's own `unitsPerBox` snapshot over the live
 * product -- correct, but on the RECONCILE path (`rebuildSiblingDrafts`, called by
 * `reconcileOrderDeliveredInvoices` / `reconcileSplitOrderDrafts`, and
 * `reconcileOrderDraftInvoice`'s single-draft branch) the "snapshot" `buildInvoiceItemData`
 * writes is REBUILT from scratch every time: `li.unitsPerBox ?? li.product?.unitsPerBox ?? 0`
 * (invoices.service.ts ~859). A box-unaware order line stores no `unitsPerBox` of its own
 * (orders.service.ts ~2129 -- the qty axis carries the unit), so that expression falls
 * through to `li.product?.unitsPerBox`: TODAY's live pack. B700's own
 * `pack-at-sale.spec.ts:48` fixture hands `toSaleLedgerLines` an item that ALREADY carries a
 * pack of 12 -- an input the real reconcile path never produces for a box-unaware line, which
 * is why it went green while this defect shipped.
 *
 * This spec drives the ACTUAL reconcile method (`reconcileOrderDeliveredInvoices`), not
 * `toSaleLedgerLines` directly, so it cannot be fooled the same way. Scenario: a standing
 * order line sold at a live pack of 12 (its prior InvoiceItem's own `unitsPerBox` is 12); the
 * product is repacked to 24; a delivery reconcile rebuilds the invoice. Before the fix, the
 * rebuilt item -- and the regulated ledger line built from it -- silently re-book at 24.
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

describe("SA-078(b) — reconcile rebuild carries the PRIOR InvoiceItem's unitsPerBox forward, never the live product", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let writeSaleEntries: jest.Mock;
  let syncInvoiceEntries: jest.Mock;

  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
    reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    writeSaleEntries = jest.fn().mockResolvedValue(undefined);
    syncInvoiceEntries = jest.fn().mockResolvedValue(undefined);

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
            writeSaleEntries,
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            syncInvoiceEntries,
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

  // The order: ONE box-unaware regulated line (no unitsPerBox of its own -- the order
  // line's qty axis carries the unit), sold as 5 (boxes) delivered in full, originally at
  // pack 12 (its PRIOR InvoiceItem carries unitsPerBox: 12). The product is NOW repacked
  // to 24 -- what a live re-read would wrongly use.
  const order = {
    id: "o1",
    customerId: "c1",
    subtotal: 100,
    tax: 0,
    lineItems: [
      {
        id: "li1",
        productId: "p1",
        qty: 5,
        deliveredQty: 5,
        unitPrice: 20,
        originalPrice: null,
        priceType: "STANDARD",
        unitsPerBox: null, // box-unaware order line -- see orders.service.ts ~2129
        trackedCategoryId: "cat-tobacco",
        product: { name: "P1", unitsPerBox: 24 }, // REPACKED since the original sale
        status: "PENDING",
      },
    ],
  };

  const draftInvoice = {
    id: "d1",
    status: InvoiceStatus.DRAFT,
    deliveryBatchId: null,
    discount: 0,
    shippingFee: 0,
  };

  function armDeliveredReconcile() {
    // The order's live, non-VOID invoices -- ONE open draft whose CURRENT item (about to
    // be deleted and recreated) carries the ORIGINAL sale's own pack snapshot, 12.
    prisma.invoice.findMany.mockResolvedValue([
      { ...draftInvoice, items: [{ orderItemId: "li1", unitsPerBox: 12 }] },
    ]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    // Echo back whatever this code actually tries to create, so the ledger-facing
    // assertion below proves the REAL created item's own field, not a fixture's.
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "d1", items: args.data.items.create }),
    );
    prisma.orderItem.update.mockResolvedValue({});
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 24 }]); // packAtSaleByProduct's live read
  }

  it("RED-FIRST (observe, do not predict): reports the rebuilt item's unitsPerBox and the ledger line's packAtSale as actually produced", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    const ledgerLine = syncInvoiceEntries.mock.calls[0][0].lines[0];
    // No expect() here on purpose -- this case exists to print what the CURRENT code
    // actually does, per SA-078(b)'s "observe, do not predict." See the PR body for the
    // captured numbers from this run.
    // eslint-disable-next-line no-console
    console.log("SA-078(b) OBSERVED:", {
      createdItemUnitsPerBox: createdItem.unitsPerBox,
      ledgerLinePackAtSale: ledgerLine.packAtSale,
      ledgerLineQty: ledgerLine.qty,
    });
  });

  it("the rebuilt item carries the PRIOR snapshot (12), not the live repacked product (24)", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(createdItem.unitsPerBox).toBe(12);
  });

  it("the regulated ledger line built from the rebuilt item also carries pack 12 -- qty 5 books unitBasisQty 60, not 120", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const ledgerLine = syncInvoiceEntries.mock.calls[0][0].lines[0];
    expect(ledgerLine.packAtSale).toBe(12);
    // regulatedUnitBasis's box-unaware branch: qty * packAtSale.
    expect(ledgerLine.qty * (ledgerLine.packAtSale as number)).toBe(60);
  });

  // reconcileOrderDeliveredInvoices only ever rebuilds lines that already have SOME
  // provenance on an existing draft (it partitions by each draft's CURRENT items'
  // orderItemId) -- a line with no prior InvoiceItem at all isn't reachable through it.
  // reconcileOrderDraftInvoice's single-draft branch is the one that rebuilds every
  // CURRENT order.lineItems regardless of prior provenance, so that's the real path for
  // this case.
  it("a GENUINELY NEW order line (no prior InvoiceItem) still snapshots the live pack (24) -- the fix never starves a first-time line of evidence", async () => {
    // reconcileSplitOrderDrafts (tried first) bails to the single-draft path below it
    // when there's only one open draft.
    prisma.invoice.findMany.mockResolvedValue([{ ...draftInvoice, items: [] }]);
    prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
    prisma.invoiceItem.findMany.mockResolvedValue([]); // no prior items for this draft at all
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "d1", items: args.data.items.create }),
    );
    prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
    prisma.orderItem.update.mockResolvedValue({});

    await service.reconcileOrderDraftInvoice("o1", { basis: "delivered" });
    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(createdItem.unitsPerBox).toBe(24);
  });

  // Second-review finding: rebuildIssuedDepositMirrorOnDelivery is a FOURTH caller of
  // the shared rebuildSiblingDrafts core (a prepaid order's mirror invoice, issued at
  // placement, has no open DRAFT for reconcileOrderDeliveredInvoices/
  // reconcileOrderDraftInvoice to find). Its own nonVoid query never selected `items`,
  // so `draft.items` was always undefined there -- the carried-pack map was always
  // empty on this ONE path, and the original defect still reproduced for deposit-mirror
  // orders after the first version of this fix. Private method -- called directly, the
  // same as this file's other tests drive the real rebuild code, not a hand-made item.
  describe("rebuildIssuedDepositMirrorOnDelivery (deposit-mirror orders, issued at placement)", () => {
    const mirrorInvoice = {
      id: "d1",
      status: InvoiceStatus.SENT,
      deliveryBatchId: null,
      depositPercent: 50,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      payments: [],
    };

    function armMirrorRebuild(priorItems: { orderItemId: string; unitsPerBox: number | null }[]) {
      prisma.invoice.findMany.mockResolvedValue([{ ...mirrorInvoice, items: priorItems }]);
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "d1", items: args.data.items.create }),
      );
      prisma.orderItem.update.mockResolvedValue({});
    }

    it("carries the prior InvoiceItem's own pack (12), not the live repacked product (24)", async () => {
      armMirrorRebuild([{ orderItemId: "li1", unitsPerBox: 12 }]);
      await (service as any).rebuildIssuedDepositMirrorOnDelivery("o1", prisma);
      const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(createdItem.unitsPerBox).toBe(12);
    });

    // This is the assertion that actually catches the second-review finding: a mock's
    // resolved value is whatever the test hands it, REGARDLESS of the real query's own
    // `select` -- reverting the source `select` clause does not change what a mocked
    // `findMany` returns here, so the test above alone cannot detect a missing field.
    // The genuine regression guard is on the QUERY SHAPE itself.
    it("asks the nonVoid query for items.orderItemId/unitsPerBox -- without this, the carried-pack map is always empty on this path", async () => {
      armMirrorRebuild([{ orderItemId: "li1", unitsPerBox: 12 }]);
      await (service as any).rebuildIssuedDepositMirrorOnDelivery("o1", prisma);
      const queryArgs = prisma.invoice.findMany.mock.calls[0][0];
      expect(queryArgs.select.items).toEqual({
        select: { orderItemId: true, unitsPerBox: true, qty: true, subtotal: true },
      });
    });
  });
});
