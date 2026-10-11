/**
 * B965 / SA-628o: the SINGLE-invoice refund still compares and prices in the order line's OWN unit (`priceReturn`,
 * `itemiseRefund`), so it cannot rest on reading alone (SA-E105). Two real-Postgres pins that a STANDARD return of N prices at
 * N x the unit value with preview == mint, for the two single-unit boxed shapes:
 *   1. a BOX-SPLIT boxed line (boxes/pieces split stored, line qty already in PIECES): N pieces back = N x $5.
 *   2. a SELLING-UNIT boxed line (qty = boxes, no split, one box-unaware invoice item): N boxes back = N x $120.
 * 3. (B969) a BOX-UNAWARE order line (qty 2 boxes, no split) whose invoice item CARRIES a split (qty 24 pieces, 2 boxes): a
 *    return of N boxes = N x $60, priced in PIECES on both sides (it refunded N x $5, 12x short, before B969).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway `qa-unit-<run>-<n>` slug approved by
 * `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "a STANDARD return on a single-unit boxed product prices at N x the unit value, preview == mint — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let returns: ReturnsService;
    let creditNotes: CreditNotesService;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          ReturnsService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `CN-UNIT-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      returns = mod.get(ReturnsService);
      creditNotes = mod.get(CreditNotesService);
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /** One boxed product (12 per box) on ONE delivered order and ONE SENT invoice; `line` is the stored shape of both lines. */
    async function seed(
      label: string,
      line: {
        qty: number;
        unitPrice: number;
        subtotal: number;
        boxes: number | null;
        pieces: number | null;
      },
      /** the stored shape of the INVOICE item when it differs from the order line's (B969: pieces vs boxes). */
      invoiceLine: typeof line = line,
    ) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-unit-${RUN}-${seq}-${label}`,
        "returns-single-invoice-units-b965.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `unit ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `P ${slug}`,
          unit: "each",
          pricePerUnit: 10,
          unitsPerBox: 12,
        } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-UNIT-${RUN}-${seq}`,
          subtotal: line.subtotal,
          tax: 0,
          total: line.subtotal,
          status: "DELIVERED",
        } as any,
      });
      await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          unitsPerBox: 12,
          ...line,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-UNIT-${RUN}-${seq}`,
          status: "SENT",
          subtotal: invoiceLine.subtotal,
          taxAmount: 0,
          total: invoiceLine.subtotal,
        },
      });
      const orderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: "P",
          unitsPerBox: 12,
          ...invoiceLine,
        } as any,
      });
      return { tenantId, customerId: customer.id, orderId: order.id, productId: product.id };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    const receivedReturn = (s: Seed, qty: number) =>
      prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          customerId: s.customerId,
          reason: "DAMAGED",
          status: "RECEIVED",
          returnNumber: `RTN-UNIT-${RUN}-${++seq}`,
          items: { create: [{ tenantId: s.tenantId, productId: s.productId, qty }] },
        } as any,
      });

    async function previewAndMint(s: Seed, qty: number) {
      const ret = await receivedReturn(s, qty);
      const preview = await tenantCtx.run(s.tenantId, () =>
        returns.findAll({ orderId: s.orderId } as any),
      );
      const row = (preview as any).data.find((r: any) => r.id === ret.id);
      const minted = await tenantCtx.run(s.tenantId, () => returns.processRefund(ret.id));
      const note = await prisma.creditNote.findFirstOrThrow({
        where: { tenantId: s.tenantId, status: { not: "VOID" } },
      });
      return { preview: Number(row.refundEstimate), mint: Number(note.amount), refunded: minted };
    }

    const splitLine = { qty: 24, unitPrice: 5, subtotal: 120, boxes: 2, pieces: 0 };

    it("1. BOX-SPLIT boxed line (2 boxes of 12 = 24 pieces @ $5, stored $120): a return of 7 pieces = $35.00, preview == mint", async () => {
      const s = await seed("split", splitLine);
      const r = await previewAndMint(s, 7);
      expect(r.preview).toBe(35);
      expect(r.mint).toBe(35);
    });

    it("1b. BOX-SPLIT: the whole line (24 pieces) = $120.00, preview == mint, and one more piece is refused", async () => {
      const s = await seed("split-all", splitLine);
      const r = await previewAndMint(s, 24);
      expect(r.preview).toBe(120);
      expect(r.mint).toBe(120);
      const more = await receivedReturn(s, 1);
      await expect(
        tenantCtx.run(s.tenantId, () => returns.processRefund(more.id)),
      ).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
    });

    it("1c. BOX-SPLIT: a $50 credit note item first (10 pieces), then a return of 14 pieces = $70.00 and 15 is refused", async () => {
      const s = await seed("split-cn", splitLine);
      const item = await prisma.invoiceItem.findFirstOrThrow({
        where: { tenantId: s.tenantId },
      });
      await tenantCtx.run(s.tenantId, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: item.invoiceId,
          amount: 50,
          items: [{ invoiceItemId: item.id, amount: 50 }],
        } as any),
      );
      const over = await receivedReturn(s, 15);
      await expect(
        tenantCtx.run(s.tenantId, () => returns.processRefund(over.id)),
      ).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
      // SA-773: a RECEIVED return reserves its goods (fail closed), so the office rejects the refused one before the smaller refunds
      await prisma.return.update({ where: { id: over.id }, data: { status: "REJECTED" } });
      const ok = await receivedReturn(s, 14);
      const minted: any = await tenantCtx.run(s.tenantId, () => returns.processRefund(ok.id));
      expect(Number(minted.refundAmount)).toBe(70);
    });

    it("2. SELLING-UNIT boxed line (qty 2 boxes @ $120, stored $240, no split): a return of 1 box = $120.00, preview == mint", async () => {
      const s = await seed("selling", {
        qty: 2,
        unitPrice: 120,
        subtotal: 240,
        boxes: null,
        pieces: null,
      });
      const r = await previewAndMint(s, 1);
      expect(r.preview).toBe(120);
      expect(r.mint).toBe(120);
    });

    // B969 shape: the order line counts BOXES (qty 2, no split), the invoice item counts PIECES (qty 24, boxes 2)
    const boxUnawareLine = { qty: 2, unitPrice: 60, subtotal: 120, boxes: null, pieces: null };
    const pieceInvoiceLine = { qty: 24, unitPrice: 5, subtotal: 120, boxes: 2, pieces: 0 };

    it("4. B969: BOX-UNAWARE order line (2 boxes) billed as 24 pieces: a return of 1 box = $60.00, preview == mint (was $5.00)", async () => {
      const s = await seed("b969", boxUnawareLine, pieceInvoiceLine);
      const r = await previewAndMint(s, 1);
      expect(r.preview).toBe(60);
      expect(r.mint).toBe(60);
    });

    it("4b. B969: the whole line (2 boxes) = $120.00, preview == mint, and one more box is refused", async () => {
      const s = await seed("b969-all", boxUnawareLine, pieceInvoiceLine);
      const r = await previewAndMint(s, 2);
      expect(r.preview).toBe(120);
      expect(r.mint).toBe(120);
      const more = await receivedReturn(s, 1);
      await expect(
        tenantCtx.run(s.tenantId, () => returns.processRefund(more.id)),
      ).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
    });

    it("3. SELLING-UNIT boxed line: a return of 2 boxes (the whole line) = $240.00, preview == mint", async () => {
      const s = await seed("selling-all", {
        qty: 2,
        unitPrice: 120,
        subtotal: 240,
        boxes: null,
        pieces: null,
      });
      const r = await previewAndMint(s, 2);
      expect(r.preview).toBe(240);
      expect(r.mint).toBe(240);
    });
  },
);
