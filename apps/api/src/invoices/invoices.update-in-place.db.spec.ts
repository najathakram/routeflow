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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
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

    it("SA-203-H notes-only save on an ORDER-LINKED invoice writes nothing to the order (legacy 0-box + 5-pcs line byte-equal)", async () => {
      const s = await seedLinked("h");
      const before = (await s.orderLines()).map(orderShape);
      const orderBefore = await prisma.order.findUnique({ where: { id: s.order.id } });
      await run(s, s.payload());
      expect((await s.orderLines()).map(orderShape)).toEqual(before);
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
  },
);
