/**
 * B670/SA-184/186/196 — DB-lane proof that `InvoicesService.update()` keeps an untouched invoice
 * line IN PLACE (same row id, money/split/pack byte-equal) against a REAL Postgres. A mocked
 * client cannot show that a `CreditNoteItem`, a regulated-ledger row or a `ReturnItem` that points
 * at a line still resolves after a save; delete-and-recreate (master) orphans all three.
 * Adopted from the prover's throwaway spec; collected only by `jest.db.config.js`
 * (`.db.spec.ts$`), run via `npm run local:test:db`. Every tenant is a throwaway
 * `qa-f2u-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants THIS run created, in FK order.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-f2u-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoices.update-in-place.db.spec.ts",
  );
}

describeDb(
  "update() keeps untouched invoice lines in place — real Postgres (B670/SA-184/196)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

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
    const mockCreditNotes = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
    };
    const mockMessaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockStorage = {
      upload: jest.fn().mockResolvedValue("stored"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    // flag.msrp OFF: applyMsrpSnapshots no-ops.
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
      // built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
          RegulatedLedgerService, // the REAL service: the resync runs against Postgres
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
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.returnItem.deleteMany({ where: { tenantId } });
      await prisma.return.deleteMany({ where: { tenantId } });
      await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await prisma.creditNote.deleteMany({ where: { tenantId } });
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.trackedCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({
        data: { slug, name: `update-in-place ${slug}` },
      });
      createdTenantIds.push(tenant.id);
      return { id: tenant.id, slug };
    }

    async function seedCustomer(tenantId: string, label: string): Promise<{ id: string }> {
      const idBase = `${tenantId}-${label}`;
      const user = await prisma.user.create({
        data: {
          email: `${idBase}@example.invalid`,
          username: idBase,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `customer ${label}`,
          contactName: `contact ${label}`,
          tenantId,
        },
      });
      return { id: customer.id };
    }

    const MONEY = [
      "qty",
      "unitPrice",
      "discount",
      "taxRate",
      "subtotal",
      "boxes",
      "pieces",
      "unitsPerBox",
      "categoryTaxAmount",
      "originalPrice",
    ] as const;
    const shape = (r: any) =>
      Object.fromEntries(MONEY.map((k) => [k, r[k] == null ? null : Number(r[k])]));

    async function seed(label: string) {
      const t = await seedTenant(label);
      const customer = await seedCustomer(t.id, label);
      const product = await prisma.product.create({
        data: {
          tenantId: t.id,
          name: `F2 boxed ${label}`,
          unit: "each",
          pricePerUnit: 2.5,
          unitsPerBox: 12,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          invoiceNumber: `INV-F2U-${RUN_SUFFIX}-${label}`,
          status: "DRAFT",
          subtotal: 103.52,
          total: 103.52,
        },
      });
      const l1 = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          description: "boxed",
          qty: 27,
          boxes: 2,
          pieces: 3,
          unitsPerBox: 12,
          unitPrice: 30,
          subtotal: 67.5,
          notes: "old1",
        },
      });
      const l2 = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          description: "plain",
          qty: 3,
          unitPrice: 12.34,
          discount: 1,
          subtotal: 36.02,
          notes: "old2",
        },
      });
      const cn = await prisma.creditNote.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          invoiceId: inv.id,
          creditNoteNumber: `CN-F2U-${RUN_SUFFIX}-${label}`,
          amount: 10,
          status: "ISSUED",
        },
      });
      const cni = await prisma.creditNoteItem.create({
        data: { tenantId: t.id, creditNoteId: cn.id, invoiceItemId: l1.id, amount: 10, qty: 3 },
      });
      // References that must still resolve after a save: a regulated-ledger row and a ReturnItem
      // pointing at the untouched line (both scalar pointers, no FK — only "kept in place" saves them).
      const cat = await prisma.trackedCategory.create({
        data: { tenantId: t.id, name: `cat ${label}` },
      });
      const ledger = await prisma.regulatedSalesLedger.create({
        data: {
          tenantId: t.id,
          trackedCategoryId: cat.id,
          invoiceId: inv.id,
          invoiceItemId: l1.id,
          qty: 27,
          soldAt: new Date(),
          periodBucket: "2026-09",
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderNumber: `ORD-F2U-${RUN_SUFFIX}-${label}`,
        },
      });
      const ret = await prisma.return.create({
        data: { tenantId: t.id, orderId: order.id, customerId: customer.id, reason: "DAMAGED" },
      });
      const retItem = await prisma.returnItem.create({
        data: {
          tenantId: t.id,
          returnId: ret.id,
          productId: product.id,
          qty: 3,
          sourceInvoiceItemId: l1.id,
        },
      });
      const payload = (over: any = {}) => ({
        items: [
          {
            id: l1.id,
            productId: product.id,
            description: "boxed",
            qty: 27,
            boxes: 2,
            pieces: 3,
            unitPrice: 30,
            notes: "NEW1",
            ...(over.l1 ?? {}),
          },
          {
            id: l2.id,
            description: "plain",
            qty: 3,
            unitPrice: 12.34,
            discount: 1,
            notes: "NEW2",
            ...(over.l2 ?? {}),
          },
        ],
        notes: "invoice note NEW",
      });
      return { t, inv, l1, l2, cni, ledger, retItem, product, payload };
    }
    const run = (s: any, dto: any) =>
      tenantCtx.run(s.t.id, () => invoicesService.update(s.inv.id, dto));
    const rows = (s: any) =>
      prisma.invoiceItem.findMany({
        where: { invoiceId: s.inv.id },
        orderBy: { createdAt: "asc" },
      });

    it("F2-A notes-only save (ids sent): same row ids, money/split/pack byte-equal, notes updated, credit-note-item ref resolves", async () => {
      const s = await seed("a");
      const before = await rows(s);
      await run(s, s.payload());
      const after = await rows(s);
      expect(after.map((r) => r.id).sort()).toEqual([s.l1.id, s.l2.id].sort());
      for (const b of before) {
        const a = after.find((r) => r.id === b.id)!;
        expect(shape(a)).toEqual(shape(b));
      }
      expect(after.find((r) => r.id === s.l1.id)!.notes).toBe("NEW1");
      expect(after.find((r) => r.id === s.l2.id)!.notes).toBe("NEW2");
      const inv = await prisma.invoice.findUnique({ where: { id: s.inv.id } });
      expect(Number(inv!.total)).toBe(103.52);
      expect(inv!.notes).toBe("invoice note NEW");
      const ref = await prisma.invoiceItem.findUnique({
        where: {
          id: (await prisma.creditNoteItem.findUnique({ where: { id: s.cni.id } }))!.invoiceItemId!,
        },
      });
      expect(ref?.id).toBe(s.l1.id);
    });

    it("F2-B id-less legacy payload equal on the full tuple matches in place (ids survive)", async () => {
      const s = await seed("b");
      const p = s.payload();
      p.items.forEach((i: any) => delete i.id);
      await run(s, p);
      expect((await rows(s)).map((r) => r.id).sort()).toEqual([s.l1.id, s.l2.id].sort());
    });

    it("F2-C one changed line: sibling verbatim + same id; changed line re-priced IN PLACE (same id)", async () => {
      const s = await seed("c");
      const before = await rows(s);
      await run(s, s.payload({ l2: { qty: 4 } }));
      const after = await rows(s);
      expect(after.map((r) => r.id).sort()).toEqual([s.l1.id, s.l2.id].sort());
      expect(shape(after.find((r) => r.id === s.l1.id)!)).toEqual(
        shape(before.find((r) => r.id === s.l1.id)!),
      );
      expect(Number(after.find((r) => r.id === s.l2.id)!.qty)).toBe(4);
      expect(Number(after.find((r) => r.id === s.l2.id)!.subtotal)).toBe(48.36);
    });

    it("F2-D dropped line is deleted; kept line keeps its id", async () => {
      const s = await seed("d");
      const p = s.payload();
      p.items = [p.items[0]];
      await run(s, p);
      expect((await rows(s)).map((r) => r.id)).toEqual([s.l1.id]);
    });

    it("F2-E an unknown / foreign line id is a 400 and nothing is written", async () => {
      const s = await seed("e");
      const before = (await rows(s)).map(shape);
      await expect(run(s, s.payload({ l2: { id: randomUUID() } }))).rejects.toMatchObject({
        status: 400,
      });
      expect((await rows(s)).map(shape)).toEqual(before);
    });

    it("F2-F notes-only save: the regulated-ledger row and the ReturnItem still resolve to the SAME invoice line", async () => {
      const s = await seed("f");
      const ledgerRowsBefore = await prisma.regulatedSalesLedger.count({
        where: { tenantId: s.t.id },
      });
      await run(s, s.payload());
      // the real ledger service ran the resync path: a notes-only save must not reverse-and-rewrite
      expect(await prisma.regulatedSalesLedger.count({ where: { tenantId: s.t.id } })).toBe(
        ledgerRowsBefore,
      );
      const ledger = await prisma.regulatedSalesLedger.findUnique({ where: { id: s.ledger.id } });
      const ret = await prisma.returnItem.findUnique({ where: { id: s.retItem.id } });
      const ledgerLine = await prisma.invoiceItem.findUnique({
        where: { id: ledger!.invoiceItemId! },
      });
      const returnLine = await prisma.invoiceItem.findUnique({
        where: { id: ret!.sourceInvoiceItemId! },
      });
      expect(ledgerLine?.id).toBe(s.l1.id);
      expect(returnLine?.id).toBe(s.l1.id);
    });

    it("F2-G SA-196: a split that would re-pack the line (12 -> 6) is refused with nothing written", async () => {
      const s = await seed("g");
      const before = (await rows(s)).map(shape);
      await expect(
        run(s, s.payload({ l1: { qty: 24, boxes: 4, pieces: 0 } })),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(
          "the split implies pack 6 but this line's pack is 12; set unitsPerBox 6 to re-pack it",
        ),
      });
      expect((await rows(s)).map(shape)).toEqual(before);
    });

    // ── SA-203: the order back-sync, against a REAL linked order ───────────────────────────────
    // (an order-less invoice proves nothing about it). A DRAFT invoice on a DELIVERED order with a
    // legacy 0-box + 5-piece line ($4.58, pack unknown) and a boxed sibling.
    async function seedLinked(label: string) {
      const t = await seedTenant(label);
      const customer = await seedCustomer(t.id, label);
      const mk = (name: string, price: number, upb: number | null) =>
        prisma.product.create({
          data: {
            tenantId: t.id,
            name: `${name} ${label}`,
            unit: "each",
            pricePerUnit: price,
            unitsPerBox: upb,
          },
        });
      const pL = await mk("legacy", 11, 12);
      const pS = await mk("sibling", 11, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderNumber: `ORD-SA203-${RUN_SUFFIX}-${label}`,
          status: "DELIVERED",
          subtotal: 26.58,
          total: 26.58,
        },
      });
      const oiL = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pL.id,
          qty: 5,
          boxes: 0,
          pieces: 5,
          unitPrice: 11,
          subtotal: 4.58,
          invoicedQty: 5,
        },
      });
      const oiS = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pS.id,
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 11,
          subtotal: 22,
          invoicedQty: 24,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-SA203-${RUN_SUFFIX}-${label}`,
          status: "DRAFT",
          subtotal: 26.58,
          total: 26.58,
        },
      });
      const iL = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: pL.id,
          orderItemId: oiL.id,
          description: "legacy",
          qty: 5,
          boxes: 0,
          pieces: 5,
          unitPrice: 11,
          subtotal: 4.58,
        },
      });
      const iS = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: pS.id,
          orderItemId: oiS.id,
          description: "sibling",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 11,
          subtotal: 22,
        },
      });
      const payload = (over: any = {}) => ({
        items: [
          {
            id: iL.id,
            productId: pL.id,
            description: "legacy",
            qty: 5,
            boxes: 0,
            pieces: 5,
            unitPrice: 11,
            notes: "n-L",
            ...(over.L ?? {}),
          },
          {
            id: iS.id,
            productId: pS.id,
            description: "sibling",
            qty: 24,
            boxes: 2,
            pieces: 0,
            unitPrice: 11,
            notes: "n-S",
            ...(over.S ?? {}),
          },
        ],
      });
      const orderLines = () =>
        prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      return { t, inv, order, oiL, oiS, iL, iS, payload, orderLines };
    }
    const orderShape = (r: any) => ({
      ...shape(r),
      subtotal: Number(r.subtotal),
      invoicedQty: Number(r.invoicedQty),
      status: r.status,
      unitLabel: r.unitLabel ?? null,
    });

    it("SA-203-H a notes-only save (the web's REAL payload: items + discount + shipping unchanged) on an ORDER-LINKED invoice moves no updatedAt on the Order or on ANY order line", async () => {
      const s = await seedLinked("h");
      const linesBefore = await s.orderLines();
      const orderBefore = await prisma.order.findUnique({ where: { id: s.order.id } });
      await run(s, { ...s.payload(), discount: 0, shippingFee: 0, notes: "n" });
      const linesAfter = await s.orderLines();
      expect(linesAfter.map((r) => r.updatedAt)).toEqual(linesBefore.map((r) => r.updatedAt));
      expect(linesAfter.map(orderShape)).toEqual(linesBefore.map(orderShape));
      const orderAfter = await prisma.order.findUnique({ where: { id: s.order.id } });
      expect(orderAfter!.updatedAt).toEqual(orderBefore!.updatedAt);
      expect(Number(orderAfter!.total)).toBe(26.58);
    });

    it("SA-203-I a one-line qty edit: the sibling ORDER line is byte-equal; the edited line's order line carries the invoice line's own split and pack", async () => {
      const s = await seedLinked("i");
      const [beforeL, beforeS] = (await s.orderLines()).map(orderShape);
      await run(s, s.payload({ S: { qty: 36, boxes: 3, pieces: 0 } }));
      const [afterL, afterS] = (await s.orderLines()).map(orderShape);
      expect(afterL).toEqual(beforeL); // legacy line: not written at all
      expect(afterS).toMatchObject({ qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 });
      expect(afterS.subtotal).not.toBe(beforeS.subtotal);
    });

    it("SA-203-J after a notes-only save the legacy line still re-prices at $4.58, not $55", async () => {
      const s = await seedLinked("j");
      await run(s, s.payload());
      await invoicesService.recomputeOrderFromInvoices(s.order.id);
      const legacy = (await s.orderLines()).find((r) => r.id === s.oiL.id)!;
      expect(Number(legacy.subtotal)).toBe(4.58);
      expect(legacy.boxes).toBe(0);
      expect(legacy.pieces).toBe(5);
    });

    it("SA-203-K two overlapping saves serialize: no P2025, and the invoice total equals the sum of its lines", async () => {
      const s = await seedLinked("k");
      const results = await Promise.allSettled([
        run(s, s.payload({ S: { qty: 36, boxes: 3, pieces: 0 } })),
        run(s, s.payload({ S: { qty: 48, boxes: 4, pieces: 0 } })),
      ]);
      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as any)?.code).not.toBe("P2025");
      }
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      const inv = await prisma.invoice.findUnique({ where: { id: s.inv.id } });
      const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: s.inv.id } });
      const sum = Math.round(lines.reduce((a, l) => a + Number(l.subtotal), 0) * 100) / 100;
      expect(Number(inv!.subtotal)).toBe(sum);
      expect(Number(inv!.total)).toBe(sum);
    });

    it("SA-203-L a tax % edit on an ORDER-LINKED invoice is written to the row, reflected in the invoice tax, and leaves the untouched legacy order line byte-equal", async () => {
      const s = await seedLinked("l");
      const [legacyBefore] = (await s.orderLines()).map(orderShape);
      await run(s, s.payload({ S: { taxRate: 0.1 } }));
      const sib = await prisma.invoiceItem.findUnique({ where: { id: s.iS.id } });
      expect(Number(sib!.taxRate)).toBe(0.1);
      const inv = await prisma.invoice.findUnique({ where: { id: s.inv.id } });
      expect(Number(inv!.taxAmount)).toBe(2.2);
      const [legacyAfter] = (await s.orderLines()).map(orderShape);
      expect(legacyAfter).toEqual(legacyBefore);
    });

    it("SA-203-M a discount-only save on an ORDER-LINKED invoice rewrites no identical order line (updatedAt untouched), but still totals the order", async () => {
      const s = await seedLinked("m");
      const before = await s.orderLines();
      await tenantCtx.run(s.t.id, () => invoicesService.update(s.inv.id, { discount: 0 } as any));
      const after = await s.orderLines();
      expect(after.map((r) => r.updatedAt)).toEqual(before.map((r) => r.updatedAt));
      expect(after.map(orderShape)).toEqual(before.map(orderShape));
    });

    it("SA-219-N an explicit pack stored on a loose line is audited as INVOICE_LINE_PACK_ATTESTED (real audit row)", async () => {
      const s = await seed("n");
      await run(s, s.payload({ l2: { qty: 4, unitsPerBox: 12 } }));
      const l2 = await prisma.invoiceItem.findUnique({ where: { id: s.l2.id } });
      expect(Number(l2!.unitsPerBox)).toBe(12);
      const audits = await prisma.auditLog.findMany({
        where: { tenantId: s.t.id, action: "INVOICE_LINE_PACK_ATTESTED", entityId: s.inv.id },
      });
      expect(audits).toHaveLength(1);
    });

    it("SA-203-P (n > 1, shared pack) two invoice lines at pack 12 feed ONE order line still stored at the old pack 24: the full recompute writes the shared 12, not the old 24", async () => {
      const t = await seedTenant("p");
      const customer = await seedCustomer(t.id, "p");
      const product = await prisma.product.create({
        data: {
          tenantId: t.id,
          name: `shared ${t.slug}`,
          unit: "each",
          pricePerUnit: 11,
          unitsPerBox: 12,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderNumber: `ORD-P-${RUN_SUFFIX}`,
          status: "DELIVERED",
          subtotal: 33,
          total: 33,
        },
      });
      // the order line was written at the OLD pack 24 (1 box + 12 pieces of 36); both invoices bill it at 12
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 36,
          boxes: 1,
          pieces: 12,
          unitsPerBox: 24,
          unitPrice: 11,
          subtotal: 33,
          invoicedQty: 36,
        },
      });
      for (const n of [1, 2]) {
        const inv = await prisma.invoice.create({
          data: {
            tenantId: t.id,
            customerId: customer.id,
            orderId: order.id,
            invoiceNumber: `INV-P${n}-${RUN_SUFFIX}`,
            status: "DRAFT",
            subtotal: 16.5,
            total: 16.5,
          },
        });
        await prisma.invoiceItem.create({
          data: {
            tenantId: t.id,
            invoiceId: inv.id,
            productId: product.id,
            orderItemId: oi.id,
            description: "shared",
            qty: 18,
            boxes: 1,
            pieces: 6,
            unitsPerBox: 12,
            unitPrice: 11,
            subtotal: 16.5,
          },
        });
      }
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(Number(after!.qty)).toBe(36);
      expect(after!.unitsPerBox).toBe(12);
      expect(after!.boxes).toBe(3);
      expect(after!.pieces).toBe(0);
    });

    // ── Opus REQUIRED on 9ee750cb: three back-sync scenarios the earlier pins did not reach ─────────
    const mkProduct = (tenantId: string, name: string, upb: number | null = null) =>
      prisma.product.create({
        data: { tenantId, name, unit: "each", pricePerUnit: 10, unitsPerBox: upb },
      });
    const orderLinesOf = (orderId: string) =>
      prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });

    it("SA-203-Q1 the web's REAL payload ({items unchanged, discount 0 -> 5}) still runs the full coverage recompute: a short-delivered line shrinks to its billed qty, a refused line cancels, and the order's rows add up", async () => {
      const t = await seedTenant("q1");
      const customer = await seedCustomer(t.id, "q1");
      const pA = await mkProduct(t.id, `A ${t.slug}`);
      const pB = await mkProduct(t.id, `B ${t.slug}`);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 160,
          total: 160,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pA.id,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        },
      });
      const lineB = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pB.id,
          qty: 6,
          unitPrice: 10,
          subtotal: 60,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          orderItemId: lineA.id,
          productId: pA.id,
          type: "DELIVERED",
          quantityDelivered: 6,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          orderItemId: lineB.id,
          productId: pB.id,
          type: "REFUSED",
          quantityDelivered: 0,
        },
      });
      const invoice: any = await tenantCtx.run(t.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 6 }],
        } as any),
      );
      const item = invoice.items[0];
      await tenantCtx.run(t.id, () =>
        invoicesService.update(invoice.id, {
          discount: 5,
          items: [
            { id: item.id, productId: pA.id, description: item.description, qty: 6, unitPrice: 10 },
          ],
        } as any),
      );
      const [a, b] = await orderLinesOf(order.id);
      expect(Number(a.qty)).toBe(6);
      expect(Number(a.subtotal)).toBe(60);
      expect(b.status).toBe("CANCELLED");
      const o = await prisma.order.findUnique({ where: { id: order.id } });
      const live = (await orderLinesOf(order.id)).filter((r) => r.status !== "CANCELLED");
      expect(Number(o!.subtotal)).toBe(live.reduce((s, r) => s + Number(r.subtotal), 0));
    });

    it("SA-203-Q2 n > 1 with NO shared pack: an order line at pack 24 fed by two pack-less invoice lines (48 + 12) is re-split at ITS pack (2 boxes + 12 pcs), not left 2 + 0", async () => {
      const t = await seedTenant("q2");
      const customer = await seedCustomer(t.id, "q2");
      const product = await mkProduct(t.id, `q2 ${t.slug}`, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 600,
          total: 600,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 60,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 24,
          unitPrice: 10,
          subtotal: 600,
          invoicedQty: 60,
        },
      });
      for (const [n, qty] of [
        [1, 48],
        [2, 12],
      ] as const) {
        const inv = await prisma.invoice.create({
          data: {
            tenantId: t.id,
            customerId: customer.id,
            orderId: order.id,
            invoiceNumber: `INV-Q2${n}-${RUN_SUFFIX}`,
            status: "DRAFT",
            subtotal: qty * 10,
            total: qty * 10,
          },
        });
        await prisma.invoiceItem.create({
          data: {
            tenantId: t.id,
            invoiceId: inv.id,
            productId: product.id,
            orderItemId: oi.id,
            description: "q2",
            qty,
            unitPrice: 10,
            subtotal: qty * 10,
          },
        });
      }
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect([Number(after!.qty), after!.boxes, after!.pieces, after!.unitsPerBox]).toEqual([
        60, 2, 12, 24,
      ]);
    });

    it("SA-203-Q3 an items save that touches only ANOTHER line still creates the order line for an invoice line whose money is already in the subtotal", async () => {
      const t = await seedTenant("q3");
      const customer = await seedCustomer(t.id, "q3");
      const p1 = await mkProduct(t.id, `p1 ${t.slug}`);
      const p3 = await mkProduct(t.id, `p3 ${t.slug}`);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 100,
          total: 100,
        },
      });
      const o1 = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: p1.id,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          invoicedQty: 9,
        },
      });
      const mkInv = (n: string) =>
        prisma.invoice.create({
          data: {
            tenantId: t.id,
            customerId: customer.id,
            orderId: order.id,
            invoiceNumber: `INV-Q3${n}-${RUN_SUFFIX}`,
            status: "DRAFT",
            subtotal: 0,
            total: 0,
          },
        });
      const invA = await mkInv("A");
      const invB = await mkInv("B");
      // A bills 6 of the order line AND carries an extra P3 line added on the invoice (no order line yet)
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: invA.id,
          productId: p1.id,
          orderItemId: o1.id,
          description: "A p1",
          qty: 6,
          unitPrice: 10,
          subtotal: 60,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: invA.id,
          productId: p3.id,
          description: "A p3",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
        },
      });
      const iB = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: invB.id,
          productId: p1.id,
          orderItemId: o1.id,
          description: "B p1",
          qty: 3,
          unitPrice: 10,
          subtotal: 30,
        },
      });
      // editing ONLY B's line (3 -> 4) makes the order fully covered (6 + 4 = 10)
      await tenantCtx.run(t.id, () =>
        invoicesService.update(invB.id, {
          discount: 0,
          shippingFee: 0,
          items: [{ id: iB.id, productId: p1.id, description: "B p1", qty: 4, unitPrice: 10 }],
        } as any),
      );
      const lines = await orderLinesOf(order.id);
      expect(lines.some((r) => r.productId === p3.id)).toBe(true);
      const o = await prisma.order.findUnique({ where: { id: order.id } });
      expect(Number(o!.subtotal)).toBe(
        lines.filter((r) => r.status !== "CANCELLED").reduce((s, r) => s + Number(r.subtotal), 0),
      );
    });

    it("SA-203-M2 a discount-only save on a NON-NORMALIZED single-line split (1 box + 14 pcs at pack 12) writes nothing to the order", async () => {
      const t = await seedTenant("m2");
      const customer = await seedCustomer(t.id, "m2");
      const product = await prisma.product.create({
        data: {
          tenantId: t.id,
          name: `m2 ${t.slug}`,
          unit: "each",
          pricePerUnit: 11,
          unitsPerBox: 12,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderNumber: `ORD-M2-${RUN_SUFFIX}`,
          status: "DELIVERED",
          subtotal: 28.6,
          total: 28.6,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 26,
          boxes: 1,
          pieces: 14,
          unitsPerBox: 12,
          unitPrice: 11,
          subtotal: 28.6,
          invoicedQty: 26,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-M2-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 28.6,
          total: 28.6,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "m2",
          qty: 26,
          boxes: 1,
          pieces: 14,
          unitsPerBox: 12,
          unitPrice: 11,
          subtotal: 28.6,
        },
      });
      const before = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      await tenantCtx.run(t.id, () => invoicesService.update(inv.id, { discount: 0 } as any));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      expect([after!.boxes, after!.pieces]).toEqual([1, 14]);
    });

    it("SA-203-M3 a discount-only save where the single invoice line has NO split over a SPLIT order line (2 boxes at pack 12) keeps the order line's own split and pack, writing nothing", async () => {
      const t = await seedTenant("m3");
      const customer = await seedCustomer(t.id, "m3");
      const product = await prisma.product.create({
        data: {
          tenantId: t.id,
          name: `m3 ${t.slug}`,
          unit: "each",
          pricePerUnit: 11,
          unitsPerBox: 12,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderNumber: `ORD-M3-${RUN_SUFFIX}`,
          status: "DELIVERED",
          subtotal: 22,
          total: 22,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 11,
          subtotal: 22,
          invoicedQty: 24,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-M3-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 22,
          total: 22,
        },
      });
      // the invoice line carries NO split (boxes/pieces null): it must not blank the order line's
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "m3",
          qty: 24,
          unitPrice: 11,
          subtotal: 22,
        },
      });
      const before = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      await tenantCtx.run(t.id, () => invoicesService.update(inv.id, { discount: 0 } as any));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      expect([after!.boxes, after!.pieces, after!.unitsPerBox]).toEqual([2, 0, 12]);
    });

    it("SA-203-Q4 an attested single-line re-pack (order line at pack 24, the one billed invoice line at 12) writes the billed split verbatim on a full recompute", async () => {
      const t = await seedTenant("q4");
      const customer = await seedCustomer(t.id, "q4");
      const product = await mkProduct(t.id, `q4 ${t.slug}`, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 360,
          total: 360,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 36,
          boxes: 1,
          pieces: 12,
          unitsPerBox: 24,
          unitPrice: 10,
          subtotal: 360,
          invoicedQty: 36,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-Q4-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 360,
          total: 360,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "q4",
          qty: 36,
          boxes: 3,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 10,
          subtotal: 360,
        },
      });
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect([Number(after!.qty), after!.boxes, after!.pieces, after!.unitsPerBox]).toEqual([
        36, 3, 0, 12,
      ]);
    });

    it("SA-227-M4 a notes-only save where the single billed line has NO split over a NON-NORMALIZED order split (1 box + 14 pcs at pack 12) keeps it 1 + 14 and writes nothing", async () => {
      const t = await seedTenant("m4");
      const customer = await seedCustomer(t.id, "m4");
      const product = await mkProduct(t.id, `m4 ${t.slug}`, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 260,
          total: 260,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 26,
          boxes: 1,
          pieces: 14,
          unitsPerBox: 12,
          unitPrice: 10,
          subtotal: 260,
          invoicedQty: 26,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-M4-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 260,
          total: 260,
        },
      });
      const ii = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "m4",
          qty: 26,
          unitPrice: 10,
          subtotal: 260,
        },
      });
      const before = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      await tenantCtx.run(t.id, () =>
        invoicesService.update(inv.id, {
          discount: 0,
          shippingFee: 0,
          notes: "n",
          items: [
            {
              id: ii.id,
              productId: product.id,
              description: "m4",
              qty: 26,
              unitPrice: 10,
              notes: "hello",
            },
          ],
        } as any),
      );
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      expect([after!.boxes, after!.pieces, after!.unitsPerBox]).toEqual([1, 14, 12]);
    });

    it("SA-227-R1 a notes-only save where the single billed line is a legacy line with NO pack (2+0) leaves the order line's pack 12 (master kept it)", async () => {
      const t = await seedTenant("r1");
      const customer = await seedCustomer(t.id, "r1");
      const product = await mkProduct(t.id, `r1 ${t.slug}`, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 240,
          total: 240,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 10,
          subtotal: 240,
          invoicedQty: 24,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-R1-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 240,
          total: 240,
        },
      });
      const ii = await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "r1",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitPrice: 10,
          subtotal: 240,
        },
      });
      const before = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      await tenantCtx.run(t.id, () =>
        invoicesService.update(inv.id, {
          discount: 0,
          shippingFee: 0,
          items: [
            {
              id: ii.id,
              productId: product.id,
              description: "r1",
              qty: 24,
              boxes: 2,
              pieces: 0,
              unitPrice: 10,
              notes: "hello",
            },
          ],
        } as any),
      );
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(after!.unitsPerBox).toBe(12);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    });

    it("SA-235-H2 a SHORT-DELIVERED line saved twice with the identical real payload: the second save moves no updatedAt on the Order or on any order line", async () => {
      const t = await seedTenant("h2");
      const customer = await seedCustomer(t.id, "h2");
      const pA = await mkProduct(t.id, `A ${t.slug}`);
      const pB = await mkProduct(t.id, `B ${t.slug}`);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 160,
          total: 160,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pA.id,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        },
      });
      const lineB = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: pB.id,
          qty: 6,
          unitPrice: 10,
          subtotal: 60,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          orderItemId: lineA.id,
          productId: pA.id,
          type: "DELIVERED",
          quantityDelivered: 6,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          orderItemId: lineB.id,
          productId: pB.id,
          type: "REFUSED",
          quantityDelivered: 0,
        },
      });
      const invoice: any = await tenantCtx.run(t.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 6 }],
        } as any),
      );
      const item = invoice.items[0];
      const dto = {
        discount: 0,
        shippingFee: 0,
        items: [
          { id: item.id, productId: pA.id, description: item.description, qty: 6, unitPrice: 10 },
        ],
      } as any;
      await tenantCtx.run(t.id, () => invoicesService.update(invoice.id, dto)); // first save: shrinks A, cancels B
      const linesBefore = await orderLinesOf(order.id);
      const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
      await tenantCtx.run(t.id, () => invoicesService.update(invoice.id, dto)); // identical second save
      const linesAfter = await orderLinesOf(order.id);
      expect(linesAfter.map((r) => r.updatedAt)).toEqual(linesBefore.map((r) => r.updatedAt));
      const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
      expect(orderAfter!.updatedAt).toEqual(orderBefore!.updatedAt);
    });

    it("SA-248-S1 a CANCELLED order line that an invoice bills is revived to PENDING (existing behaviour, explicit)", async () => {
      const t = await seedTenant("s1");
      const customer = await seedCustomer(t.id, "s1");
      const product = await mkProduct(t.id, `s1 ${t.slug}`);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 50,
          total: 50,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          status: "CANCELLED",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          invoicedQty: 0,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-S1-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 50,
          total: 50,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "s1",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
        },
      });
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const after = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect(after!.status).toBe("PENDING");
      expect(Number(after!.qty)).toBe(5);
    });

    it("SA-257-T1 (corner 1) a legacy order line 1 box + 14 pcs (qty 26) with NO saved pack, billed by ONE no-split invoice line at pack 24: recompute writes 1 + 2 at pack 24 (26 pcs), not 1 + 14 at 24 (38)", async () => {
      const t = await seedTenant("t1");
      const customer = await seedCustomer(t.id, "t1");
      const product = await mkProduct(t.id, `t1 ${t.slug}`, 24);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 260,
          total: 260,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 26,
          boxes: 1,
          pieces: 14,
          unitPrice: 10,
          subtotal: 260,
          invoicedQty: 26,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-T1-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 260,
          total: 260,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "t1",
          qty: 26,
          unitsPerBox: 24,
          unitPrice: 10,
          subtotal: 260,
        },
      });
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const a = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect([Number(a!.qty), a!.boxes, a!.pieces, a!.unitsPerBox]).toEqual([26, 1, 2, 24]);
    });

    it("SA-257-T2 (corner 2) a legacy invoice line 1 + 0 with NO pack (qty 24) over an order line at pack 12: recompute writes 2 + 0 at pack 12, not 1 + 0 (12 pcs)", async () => {
      const t = await seedTenant("t2");
      const customer = await seedCustomer(t.id, "t2");
      const product = await mkProduct(t.id, `t2 ${t.slug}`, 12);
      const order = await prisma.order.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: 240,
          total: 240,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId: t.id,
          orderId: order.id,
          productId: product.id,
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 10,
          subtotal: 240,
          invoicedQty: 24,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-T2-${RUN_SUFFIX}`,
          status: "DRAFT",
          subtotal: 240,
          total: 240,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          orderItemId: oi.id,
          description: "t2",
          qty: 24,
          boxes: 1,
          pieces: 0,
          unitPrice: 10,
          subtotal: 240,
        },
      });
      await tenantCtx.run(t.id, () => invoicesService.recomputeOrderFromInvoices(order.id));
      const a = await prisma.orderItem.findUnique({ where: { id: oi.id } });
      expect([Number(a!.qty), a!.boxes, a!.pieces, a!.unitsPerBox]).toEqual([24, 2, 0, 12]);
    });

    describe("H4: a stale editor cannot overwrite a newer save (expectedUpdatedAt -> 409 INVOICE_STALE)", () => {
      const stamp = async (s: any): Promise<string> =>
        (
          await prisma.invoice.findUniqueOrThrow({ where: { id: s.inv.id } })
        ).updatedAt.toISOString();

      it("H4-A the INV-2026-0015 replay: two editors open the same draft; the second save is 409 and deletes nothing", async () => {
        const s = await seed("h4a");
        const opened = await stamp(s); // both editors loaded the draft at this updatedAt
        const first = s.payload();
        first.items = [first.items[0]]; // editor 1 removes the plain line and saves
        await run(s, { ...first, expectedUpdatedAt: opened });
        const afterFirst = await rows(s);
        expect(afterFirst.map((r) => r.id)).toEqual([s.l1.id]);
        const invAfterFirst = await prisma.invoice.findUniqueOrThrow({ where: { id: s.inv.id } });

        // editor 2 still holds the old two-line form and saves it with the token it opened at
        await expect(
          run(s, { ...s.payload({ l1: { notes: "STALE" } }), expectedUpdatedAt: opened }),
        ).rejects.toMatchObject({ status: 409, response: { code: "INVOICE_STALE" } });

        const afterStale = await rows(s);
        expect(afterStale.map((r) => r.id)).toEqual([s.l1.id]); // nothing re-added, nothing deleted
        expect(afterStale[0].notes).toBe(afterFirst[0].notes);
        const invAfterStale = await prisma.invoice.findUniqueOrThrow({ where: { id: s.inv.id } });
        expect(invAfterStale.updatedAt.toISOString()).toBe(invAfterFirst.updatedAt.toISOString());
        expect(Number(invAfterStale.total)).toBe(Number(invAfterFirst.total));
      });

      it("H4-B the current token saves; the token returned by that save is the next current one", async () => {
        const s = await seed("h4b");
        const saved: any = await run(s, { ...s.payload(), expectedUpdatedAt: await stamp(s) });
        expect(saved.updatedAt.toISOString()).toBe(await stamp(s));
        await run(s, {
          ...s.payload({ l2: { qty: 4 } }),
          expectedUpdatedAt: saved.updatedAt.toISOString(),
        });
        expect(Number((await rows(s)).find((r) => r.id === s.l2.id)!.qty)).toBe(4);
      });

      it("H4-C header-only saves (discount, and notes alone) also refuse a stale token and write nothing", async () => {
        const s = await seed("h4c");
        const opened = await stamp(s);
        await run(s, { notes: "editor 1", expectedUpdatedAt: opened });
        const mid = await prisma.invoice.findUniqueOrThrow({ where: { id: s.inv.id } });
        await expect(run(s, { discount: 5, expectedUpdatedAt: opened })).rejects.toMatchObject({
          status: 409,
          response: { code: "INVOICE_STALE" },
        });
        await expect(
          run(s, { notes: "editor 2", expectedUpdatedAt: opened }),
        ).rejects.toMatchObject({ status: 409, response: { code: "INVOICE_STALE" } });
        const end = await prisma.invoice.findUniqueOrThrow({ where: { id: s.inv.id } });
        expect(end.notes).toBe("editor 1");
        expect(Number(end.discount)).toBe(Number(mid.discount));
        expect(end.updatedAt.toISOString()).toBe(mid.updatedAt.toISOString());
      });

      it("H4-D a client that sends no token is still accepted for one release, with a warn log", async () => {
        const s = await seed("h4d");
        const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
        await run(s, s.payload());
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("expectedUpdatedAt"));
        warn.mockRestore();
        expect((await rows(s)).map((r) => r.id).sort()).toEqual([s.l1.id, s.l2.id].sort());
      });
    });
  },
);
