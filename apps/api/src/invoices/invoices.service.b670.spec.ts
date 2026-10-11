/**
 * B670/B701/B674 (SA-184, SA-186, SA-189) — update() keeps untouched lines verbatim and in place, and
 * re-prices only changed ones from their OWN pack.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow).
 * Same bootstrap pattern as the main spec file; duplicated deliberately rather than shared, so
 * this file stays self-contained and small.
 */

// Prevent Jest from traversing ESM-only dependencies
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { InvoiceStatus } from "@prisma/client";

describe("InvoicesService — update() line preservation", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("update() — untouched lines are preserved, changed lines use their own pack", () => {
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
    // A legacy line: 0 boxes + 5 pieces at $11/box, never snapshotted a pack, billed $4.58.
    const legacy = (over: any = {}) => ({
      id: "item-legacy",
      productId: "prod-box",
      description: "Chips",
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitPrice: 11,
      discount: 0,
      taxRate: 0,
      subtotal: 4.58,
      unitsPerBox: null,
      categoryTaxAmount: 0,
      notes: null,
      orderItemId: null,
      ...over,
    });
    const payload = (over: any = {}) => ({
      id: "item-legacy",
      productId: "prod-box",
      description: "Chips",
      qty: 5,
      unitPrice: 11,
      boxes: 0,
      pieces: 5,
      ...over,
    });
    const arrange = (rows: any[], over: { livePack?: number; category?: boolean } = {}) => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-box",
          unitsPerBox: over.livePack ?? 6,
          trackedCategoryId: over.category ? "cat-1" : null,
        },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue(
        over.category
          ? [{ id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.1, priceIncludesTax: false }]
          : [],
      );
      prisma.invoiceItem.findMany.mockResolvedValue(rows);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);
      prisma.invoiceItem.update.mockResolvedValue({});
    };
    const saved = () => prisma.invoice.update.mock.calls[0][0].data;
    /** SA-184: an invoice edit never writes back to the order it came from. */
    const expectNoOrderSync = () => {
      for (const m of [
        prisma.order.update,
        prisma.order.updateMany,
        prisma.orderItem.update,
        prisma.orderItem.updateMany,
        prisma.orderItem.create,
        prisma.orderItem.deleteMany,
      ]) {
        expect(m).not.toHaveBeenCalled();
      }
    };

    it("a notes-only save of a legacy 0-box + 5-piece line ($4.58, pack unknown) leaves the money and split exactly as stored", async () => {
      arrange([legacy()]);
      await service.update("inv-box", { notes: "call ahead", items: [payload()] } as any);
      expect(saved().items.create).toEqual([]); // kept in place, not recreated
      expect(saved().subtotal).toBe(4.58);
      expectNoOrderSync();
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      expect(prisma.invoiceItem.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: "inv-box", id: { notIn: ["item-legacy"] } },
      });
    });

    it("the same save from an OLD cached client (no id) matches on the full tuple and still preserves the line", async () => {
      arrange([legacy()]);
      await service.update("inv-box", { notes: "x", items: [payload({ id: undefined })] } as any);
      expect(saved().items.create).toEqual([]);
      expect(saved().subtotal).toBe(4.58);
    });

    it("editing its qty without a split is refused, naming the line, and nothing is written", async () => {
      arrange([legacy()]);
      await expect(
        service.update("inv-box", {
          items: [
            {
              id: "item-legacy",
              productId: "prod-box",
              description: "Chips",
              qty: 6,
              unitPrice: 11,
            },
          ],
        } as any),
      ).rejects.toThrow("set the box and piece count for Chips to edit it");
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    });

    it("the id-less edit of that legacy line is refused too (fail-closed for old clients)", async () => {
      arrange([legacy()]);
      await expect(
        service.update("inv-box", {
          items: [payload({ id: undefined, qty: 6, boxes: undefined, pieces: undefined })],
        } as any),
      ).rejects.toThrow("set the box and piece count");
    });

    it("after the operator sets 0 boxes + 6 pieces at pack 12 the line is prorated at 12 and that pack is stored on THAT row", async () => {
      arrange([legacy()]);
      await service.update("inv-box", {
        items: [payload({ qty: 6, pieces: 6, unitsPerBox: 12 })],
      } as any);
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "item-legacy" },
        data: expect.objectContaining({
          qty: 6,
          boxes: 0,
          pieces: 6,
          unitsPerBox: 12,
          subtotal: 5.5,
        }),
      });
      // SA-189(4): the attested pack is in the audit trail, so it can be told from a recovered one.
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "INVOICE_LINE_PACK_ATTESTED",
          entityType: "invoice",
          entityId: "inv-box",
          meta: { attested: [{ rowId: "item-legacy", unitsPerBox: 12 }] },
        }),
      });
    });

    it("an explicit pack on an UNCHANGED line is ignored: a stale client cannot re-pack a preserved row", async () => {
      arrange([legacy()]);
      await service.update("inv-box", { items: [payload({ unitsPerBox: 24 })] } as any);
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      expect(saved().subtotal).toBe(4.58);
    });

    it("an explicit pack that disagrees with a recoverable pack is refused, not silently overridden", async () => {
      arrange([legacy({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, subtotal: 22 })]);
      await expect(
        service.update("inv-box", {
          items: [payload({ qty: 36, boxes: 3, pieces: 0, unitsPerBox: 24 })],
        } as any),
      ).rejects.toThrow("disagrees with this line's own pack 12");
    });

    it("an explicit pack whose split does not add up to qty is refused", async () => {
      arrange([legacy()]);
      await expect(
        service.update("inv-box", {
          items: [payload({ qty: 7, pieces: 6, unitsPerBox: 12 })],
        } as any),
      ).rejects.toThrow("is not 0 boxes x 12 + 6 pieces");
    });

    describe("SA-203 review fixes", () => {
      const line = (over: any = {}) =>
        legacy({ id: "a", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, subtotal: 22, ...over });
      const linked = (over: Record<string, unknown> = {}) => {
        prisma.invoice.findUnique.mockResolvedValue({ ...draftInvoice, orderId: "ord-1", ...over });
        prisma.order.findFirst.mockResolvedValue({
          status: "DELIVERED",
          orderNumber: "1",
          lineItems: [],
        });
      };
      let resync: jest.SpyInstance;
      beforeEach(() => {
        resync = jest.spyOn(service, "recomputeOrderFromInvoices").mockResolvedValue(null as any);
      });

      it("a tax % edit is a change: the row is re-priced in place and the invoice tax follows", async () => {
        arrange([line({ taxRate: 0.08 })]);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0, taxRate: 0.1 })],
        } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: expect.objectContaining({ taxRate: 0.1 }),
        });
        expect(saved().taxAmount).toBe(2.2);
      });

      it("an unchanged tax % stays untouched (no row write)", async () => {
        arrange([line({ taxRate: 0.08 })]);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0, taxRate: 0.08 })],
        } as any);
        expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      });

      it("an unlocked line with boxes >= 1 still audits the operator's pack (whatever the split shape)", async () => {
        // stored 2 boxes / 0 pcs / qty 2: the pack is unrecoverable (qty/boxes = 1), so the editor locked it
        arrange([line({ qty: 2, unitsPerBox: null, subtotal: 22 })]);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 })],
        } as any);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            action: "INVOICE_LINE_PACK_ATTESTED",
            meta: { attested: [{ rowId: "a", unitsPerBox: 12 }] },
          }),
        });
      });

      it("an order-linked notes-only save still runs the full recompute (SA-235: no payload-shape gate); the zero-write is by updatedAt in the DB spec", async () => {
        arrange([line()]);
        linked();
        await service.update("inv-box", {
          notes: "n",
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0, notes: "hello" })],
        } as any);
        expect(resync).toHaveBeenCalledTimes(1);
        expect(resync.mock.calls[0]).toEqual(["ord-1"]);
      });

      it("an order-linked qty edit runs the FULL coverage recompute exactly once (SA-233: no changed-set)", async () => {
        const sibling = line({ id: "b", orderItemId: "oi-b", productId: "prod-b" });
        arrange([line({ orderItemId: "oi-a" }), sibling]);
        linked();
        await service.update("inv-box", {
          items: [
            payload({ id: "a", qty: 36, boxes: 3, pieces: 0 }),
            payload({ id: "b", productId: "prod-b", qty: 24, boxes: 2, pieces: 0 }),
          ],
        } as any);
        expect(resync).toHaveBeenCalledTimes(1);
        expect(resync.mock.calls[0]).toEqual(["ord-1"]);
      });

      it("1b: a discount/shipping-only save on an order-linked invoice still runs the full coverage recompute (short-delivered lines shrink, refused lines cancel); identical rows are skipped inside it", async () => {
        const row = line();
        arrange([row]);
        // B1043 (F1): the header-only PATCH trusts the stored header only when it matches the lines.
        linked({ subtotal: row.subtotal, total: row.subtotal });
        await service.update("inv-box", { discount: 5 } as any);
        expect(resync).toHaveBeenCalledTimes(1);
        expect(resync.mock.calls[0][2]).toBeUndefined(); // no changed-set: NOT the items-save mode
      });

      it("3: an explicit pack stored on a box-UNAWARE line is audited as an attestation too", async () => {
        arrange([line({ boxes: null, pieces: null, unitsPerBox: null, qty: 24, subtotal: 240 })]);
        await service.update("inv-box", {
          items: [
            payload({ id: "a", qty: 30, boxes: undefined, pieces: undefined, unitsPerBox: 12 }),
          ],
        } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: expect.objectContaining({ unitsPerBox: 12 }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            action: "INVOICE_LINE_PACK_ATTESTED",
            meta: { attested: [{ rowId: "a", unitsPerBox: 12 }] },
          }),
        });
      });

      describe("3 / SA-219: the loose (box-unaware) branch follows the same pack rule as the split branch", () => {
        const loose = (over: any = {}) =>
          line({ boxes: null, pieces: null, unitsPerBox: 12, qty: 24, subtotal: 240, ...over });
        const looseEdit = (over: any = {}) =>
          payload({ id: "a", qty: 30, boxes: undefined, pieces: undefined, ...over });

        it("explicit pack ABSENT: the row's own snapshot is kept, nothing to attest", async () => {
          arrange([loose()]);
          await service.update("inv-box", { items: [looseEdit()] } as any);
          expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
            where: { id: "a" },
            data: expect.objectContaining({ unitsPerBox: 12 }),
          });
          expect(prisma.auditLog.create).not.toHaveBeenCalled();
        });

        it("explicit pack EQUAL to the recovered snapshot is ignored: unchanged, no audit row", async () => {
          arrange([loose()]);
          await service.update("inv-box", { items: [looseEdit({ unitsPerBox: 12 })] } as any);
          expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
            where: { id: "a" },
            data: expect.objectContaining({ unitsPerBox: 12 }),
          });
          expect(prisma.auditLog.create).not.toHaveBeenCalled();
        });

        it("explicit pack DIFFERENT from a recovered snapshot is a 400 disagreement, nothing written", async () => {
          arrange([loose()]);
          await expect(
            service.update("inv-box", { items: [looseEdit({ unitsPerBox: 6 })] } as any),
          ).rejects.toThrow("the pack 6 disagrees with this line's own pack 12");
          expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
        });

        it("explicit pack with NO recovered snapshot is stored and audited as an attestation", async () => {
          arrange([loose({ unitsPerBox: null })]);
          await service.update("inv-box", { items: [looseEdit({ unitsPerBox: 12 })] } as any);
          expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
            where: { id: "a" },
            data: expect.objectContaining({ unitsPerBox: 12 }),
          });
          expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
              action: "INVOICE_LINE_PACK_ATTESTED",
              meta: { attested: [{ rowId: "a", unitsPerBox: 12 }] },
            }),
          });
        });
      });

      it("5: an orderItemId-only relink of an untouched line counts as a change: the order and the ledger resync", async () => {
        arrange([line({ orderItemId: "oi-old" })]);
        linked();
        prisma.orderItem.findMany.mockResolvedValue([
          { id: "oi-new", productId: "prod-box", status: "PENDING" },
        ]);
        const resyncLedger = jest
          .spyOn(service as any, "resyncInvoiceLedger")
          .mockResolvedValue(undefined);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0, orderItemId: "oi-new" })],
        } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: { orderItemId: "oi-new" },
        });
        expect(resync).toHaveBeenCalledTimes(1);
        expect(resyncLedger).toHaveBeenCalledTimes(1);
      });

      it("locks the ORDER row before the invoice row when the invoice is order-linked", async () => {
        arrange([line()]);
        linked();
        const raw = jest.fn().mockResolvedValue(0);
        prisma.tenantTransaction.mockImplementationOnce((fn: any) =>
          fn({
            ...prisma.forTenant(),
            $executeRaw: raw,
            $queryRaw: jest.fn().mockResolvedValue([]),
          }),
        );
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0 })],
        } as any);
        const locks = raw.mock.calls.map((c: any) => c[0].join("?"));
        const order = locks.findIndex((q: string) => q.includes('"Order"'));
        const invoice = locks.findIndex((q: string) => q.includes('"Invoice"'));
        expect(order).toBeGreaterThanOrEqual(0);
        expect(order).toBeLessThan(invoice);
      });
    });

    describe("SA-196 follow-ups: the row's own pack, not the live product's", () => {
      const pack6 = () =>
        legacy({ id: "a", qty: 12, boxes: 2, pieces: 0, unitsPerBox: 6, subtotal: 22 });

      it("row pack 6 vs live product pack 12: a same-pack edit stays at 6 and needs no attestation", async () => {
        arrange([pack6()], { livePack: 12 });
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 18, boxes: 3, pieces: 0 })],
        } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: expect.objectContaining({ boxes: 3, unitsPerBox: 6, subtotal: 33 }),
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("row pack 6 vs live product pack 12: a split at the LIVE pack is still a re-pack and is refused", async () => {
        arrange([pack6()], { livePack: 12 });
        await expect(
          service.update("inv-box", {
            items: [payload({ id: "a", qty: 24, boxes: 2, pieces: 0 })],
          } as any),
        ).rejects.toThrow("the split implies pack 12 but this line's pack is 6");
      });

      it("a row with NO saved pack but a readable split (2 x 12) cannot be re-split to 4 x 6 silently", async () => {
        arrange([
          legacy({ id: "a", qty: 24, boxes: 2, pieces: 0, unitsPerBox: null, subtotal: 22 }),
        ]);
        await expect(
          service.update("inv-box", {
            items: [payload({ id: "a", qty: 24, boxes: 4, pieces: 0 })],
          } as any),
        ).rejects.toThrow("the split implies pack 6 but this line's pack is 12; set unitsPerBox 6");
        expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      });

      it("...but it can once the operator attests the new pack (audited)", async () => {
        arrange([
          legacy({ id: "a", qty: 24, boxes: 2, pieces: 0, unitsPerBox: null, subtotal: 22 }),
        ]);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 24, boxes: 4, pieces: 0, unitsPerBox: 6 })],
        } as any);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ action: "INVOICE_LINE_PACK_ATTESTED" }),
        });
      });

      it("a notes-only save of a regulated invoice does not touch the ledger", async () => {
        arrange([pack6()]);
        const resync = jest
          .spyOn(service as any, "resyncInvoiceLedger")
          .mockResolvedValue(undefined);
        await service.update("inv-box", {
          items: [payload({ id: "a", qty: 12, boxes: 2, pieces: 0, notes: "x" })],
        } as any);
        expect(resync).not.toHaveBeenCalled();
      });
    });

    describe("SA-196: a new split implying a different pack than the row's own snapshot", () => {
      const packed6 = () =>
        legacy({ id: "a", qty: 12, boxes: 2, pieces: 0, unitsPerBox: 6, subtotal: 22 });
      const repackPayload = (over: any = {}) =>
        payload({ id: "a", qty: 24, boxes: 2, pieces: 0, ...over });

      it("is refused with the implied and current pack named when unitsPerBox is not sent", async () => {
        arrange([packed6()]);
        await expect(
          service.update("inv-box", { items: [repackPayload()] } as any),
        ).rejects.toThrow(
          "the split implies pack 12 but this line's pack is 6; set unitsPerBox 12 to re-pack it",
        );
        expect(prisma.invoice.update).not.toHaveBeenCalled();
        expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      });

      it("is refused when unitsPerBox is sent but is not the implied pack", async () => {
        arrange([packed6()]);
        await expect(
          service.update("inv-box", { items: [repackPayload({ unitsPerBox: 6 })] } as any),
        ).rejects.toThrow("the split implies pack 12 but this line's pack is 6");
      });

      it("is allowed once unitsPerBox equals the implied pack, and is audited as an attestation", async () => {
        arrange([packed6()]);
        await service.update("inv-box", { items: [repackPayload({ unitsPerBox: 12 })] } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: expect.objectContaining({ boxes: 2, pieces: 0, unitsPerBox: 12 }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            action: "INVOICE_LINE_PACK_ATTESTED",
            meta: { attested: [{ rowId: "a", unitsPerBox: 12 }] },
          }),
        });
      });

      it("a split that implies the SAME pack needs no attestation and writes no audit row", async () => {
        arrange([packed6()]);
        await service.update("inv-box", {
          items: [repackPayload({ qty: 18, boxes: 3, pieces: 0 })],
        } as any);
        expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
          where: { id: "a" },
          data: expect.objectContaining({ boxes: 3, unitsPerBox: 6 }),
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });
    });

    it("a sibling line at pack 24 changes nothing; the edited line uses ITS OWN pack 12", async () => {
      const a = legacy({ id: "a", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, subtotal: 22 });
      const b = legacy({ id: "b", qty: 48, boxes: 2, pieces: 0, unitsPerBox: 24, subtotal: 22 });
      arrange([a, b]);
      await service.update("inv-box", {
        items: [
          payload({ id: "a", qty: 36, boxes: 3, pieces: 0 }),
          payload({ id: "b", qty: 48, boxes: 2, pieces: 0 }),
        ],
      } as any);
      expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(1);
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "a" },
        data: expect.objectContaining({ boxes: 3, unitsPerBox: 12, subtotal: 33 }),
      });
      expectNoOrderSync();
    });

    it("an unknown line id is a 400 'unknown line id' and nothing is written", async () => {
      arrange([legacy()]);
      await expect(
        service.update("inv-box", {
          items: [payload({ id: "11111111-1111-4111-8111-111111111111" })],
        } as any),
      ).rejects.toThrow("unknown line id");
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("an id from ANOTHER invoice is unknown here: the lookup is only ever this invoice's own rows", async () => {
      arrange([legacy()]); // this invoice's rows only
      await expect(
        service.update("inv-box", { items: [payload({ id: "item-of-another-invoice" })] } as any),
      ).rejects.toThrow("unknown line id");
      // Only this invoice's rows were read (tenant-scoped client): nothing else was looked up. F-05 PR2 adds
      // two reads of the SAME rows (the sell check's held lines, pre-lock and again under the row lock), so
      // every read is pinned to this invoice alone rather than counted.
      const reads = prisma.invoiceItem.findMany.mock.calls.map(([args]: any[]) => args.where);
      expect(reads.length).toBeGreaterThan(0);
      for (const where of reads) expect(where).toEqual({ invoiceId: "inv-box" });
      expect(prisma.invoiceItem.findMany).toHaveBeenCalledWith({ where: { invoiceId: "inv-box" } });
    });

    it("a stored row the payload drops is deleted; a brand-new line is created", async () => {
      arrange([legacy(), legacy({ id: "gone", description: "Old" })]);
      await service.update("inv-box", {
        items: [
          payload(),
          {
            productId: "prod-box",
            description: "New",
            qty: 12,
            unitPrice: 11,
            boxes: 1,
            pieces: 0,
          },
        ],
      } as any);
      expect(prisma.invoiceItem.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: "inv-box", id: { notIn: ["item-legacy"] } },
      });
      expect(saved().items.create).toHaveLength(1);
      expect(saved().items.create[0]).toMatchObject({ description: "New", unitsPerBox: 12 });
    });

    // SA-180 leg: the levy basis is the resolved pack, never the live product alone.
    it("levy: an untouched box-unaware line (stored pack 12, live 6) keeps its stored $6.00; changing its qty re-prices at its OWN 12", async () => {
      const row = legacy({
        qty: 5,
        boxes: null,
        pieces: null,
        unitPrice: 10,
        subtotal: 50,
        unitsPerBox: 12,
        categoryTaxAmount: 6,
        // a regulated line, as a real one is: its category and the trio it was priced at (B297 row 338: a
        // row with NO category but a stored levy keeps that levy instead of re-pricing at the product's)
        trackedCategoryId: "cat-1",
        categoryTaxType: "EXCISE_PER_UNIT",
        categoryTaxRate: 0.1,
        categoryPriceIncludesTax: false,
      });
      arrange([row], { category: true });
      await service.update("inv-box", {
        items: [
          { id: "item-legacy", productId: "prod-box", description: "Chips", qty: 5, unitPrice: 10 },
        ],
      } as any);
      expect(saved().taxAmount).toBe(6); // stored levy, untouched (not 5 x 6 x 0.10 = 3)
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled();

      prisma.invoice.update.mockClear();
      await service.update("inv-box", {
        items: [
          { id: "item-legacy", productId: "prod-box", description: "Chips", qty: 6, unitPrice: 10 },
        ],
      } as any);
      // 6 units x own pack 12 = 72 pieces x $0.10 = $7.20 (not 6 x 6 x 0.10 = 3.60 at the live pack)
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "item-legacy" },
        data: expect.objectContaining({ qty: 6, categoryTaxAmount: 7.2 }),
      });
    });

    it("levy (NULL trio): a legacy regulated row with no stamped trio still prices at its OWN pack 12 and stamps the live category's trio", async () => {
      const row = legacy({
        qty: 5,
        boxes: null,
        pieces: null,
        unitPrice: 10,
        subtotal: 50,
        unitsPerBox: 12,
        categoryTaxAmount: 6,
        trackedCategoryId: "cat-1", // regulated, but sold before the trio was stamped
        categoryTaxType: null,
        categoryTaxRate: null,
        categoryPriceIncludesTax: null,
      });
      arrange([row], { category: true });
      await service.update("inv-box", {
        items: [
          { id: "item-legacy", productId: "prod-box", description: "Chips", qty: 6, unitPrice: 10 },
        ],
      } as any);
      // 6 units x own pack 12 = 72 pieces x the category's live $0.10 = $7.20, and the trio is stamped
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "item-legacy" },
        data: expect.objectContaining({
          qty: 6,
          categoryTaxAmount: 7.2,
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.1,
          categoryPriceIncludesTax: false,
        }),
      });
    });

    it("a NEW line with no stored row still falls back to the live pack (no snapshot exists yet)", async () => {
      arrange([], { category: true });
      await service.update("inv-box", {
        items: [{ productId: "prod-box", description: "Chips", qty: 5, unitPrice: 10 }],
      } as any);
      expect(saved().items.create[0].categoryTaxAmount).toBe(3); // 5 x live 6 x 0.10
    });
  });
});
