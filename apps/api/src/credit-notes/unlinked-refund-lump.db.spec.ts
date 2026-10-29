/**
 * SA-1053 (I-192) on REAL Postgres: a standard return on a NEVER-INVOICED order is refunded as store credit, an ISSUED itemless
 * credit note with no invoice and no order link. After the order is invoiced the credit readers must still count that note, or a
 * typed credit on the same line is allowed on top of it (200.00 credited against a 100.00 line). The read side refuses; the mint
 * is unchanged. Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 *
 *   R-N1  one invoice, a typed credit of the line's full 100.00 after the refund: CREDIT_NOTE_OVER_HEADROOM, nothing written.
 *   R-N2  the same on a two-line order (X and Y): refused on X; G-N6: the same credit on Y is allowed.
 *   R-N3  the same with 10% tax on the invoice: refused.
 *   R-N5  X invoiced on A and Y on B (the order pool): a typed credit on X at A is refused.
 *   G-N7  an invoice with no order: unchanged, allowed.
 *   G-N8  ANOTHER order's refund lump queued to this order (OrderCreditNote) is not attributed here: allowed.
 *   G-N9  the unlinked note is VOID: not counted, allowed.
 *   G-N10 an INLINE return's note is counted once, by the inline term (not twice by the helper).
 *   G-N11 a refund minted ON an invoice is counted once, by the invoice term.
 *   R-A1  (A-1) X billed on invoices A and B, 1 unit refunded before invoicing: an INLINE capture of the 1 owed unit is allowed
 *         by line (the unlinked term follows the SA-727 sole-invoice rule); the pool still counts the refunded unit once.
 *   G-A2  (A-1) the order pool bind (loadOrderPool + pooledTakeRefusal, what the capture runs) counts the refunded unit once: the 1
 *         owed unit fits, a 2nd is refused.
 *   G-A3  (A-1) R-N5 above is still refused through the pool.   G-A4 (A-1) R-N1 above is still refused through loadLineCredits.
 *   G-N13 staff later queue the unlinked note to the order (OrderCreditNote): counted once, so the line keeps exactly its
 *         remaining room (a second typed credit is refused, the first one is not).
 *
 * Every tenant is a throwaway `qa-i192-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  loadLineCredits,
  loadOrderPool,
  pooledTakeRefusal,
  toHeadroomLine,
} from "./line-credit-headroom";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const UNIT = 100;

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  slug: string;
}
interface Line {
  productId: string;
  name: string;
  qty: number;
  orderItemId: string;
}
interface Inv {
  id: string;
  lines: Array<{ id: string; productId: string }>;
}

describeDb(
  "SA-1053: a refund minted before the order was invoiced still counts — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    let returns: ReturnsService;
    let inline: any;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;
    let invSeq = 0;

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
              reserveNext: jest.fn().mockImplementation(async () => `CN-I192-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      creditNotes = mod.get(CreditNotesService);
      returns = mod.get(ReturnsService);
      const numbering = {
        reserveNext: jest.fn().mockImplementation(async () => `CN-I192-${RUN}-i${++cnSeq}`),
      };
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      inline = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: anyMethod,
        ledger: mod.get(RegulatedLedgerService),
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
        idempotency: new IdempotencyService(),
      });
    }, 120_000);

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.orderCreditNote.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    async function mkFx(label: string): Promise<Fx> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-i192-${RUN}-${seq}-${label}`,
        "unlinked-refund-lump.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `i192 ${slug}` } });
      tenantIds.push(tenant.id);
      const user = await prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `c ${label}`,
          contactName: `c ${label}`,
          tenantId: tenant.id,
        },
      });
      return { tenantId: tenant.id, userId: user.id, customerId: customer.id, slug };
    }

    /** A DELIVERED order whose lines each sell `qty` x 100.00 of their own product (`names` = the products, in line order). */
    async function mkOrder(
      fx: Fx,
      names: string[],
      qtys: number[] = names.map(() => 1),
    ): Promise<{ id: string; lines: Line[] }> {
      invSeq += 1;
      const base = qtys.reduce((t, q) => t + q * UNIT, 0);
      const order = await prisma.order.create({
        data: {
          tenantId: fx.tenantId,
          customerId: fx.customerId,
          orderNumber: `ORD-I192-${RUN}-${invSeq}`,
          subtotal: base,
          tax: 0,
          total: base,
          status: "DELIVERED",
        } as any,
      });
      const lines: Line[] = [];
      for (const [i, name] of names.entries()) {
        const product = await prisma.product.create({
          data: {
            tenantId: fx.tenantId,
            name: `${name} ${fx.slug}`,
            unit: "each",
            pricePerUnit: UNIT,
          },
        });
        const oi = await prisma.orderItem.create({
          data: {
            tenantId: fx.tenantId,
            orderId: order.id,
            productId: product.id,
            name: product.name,
            position: i,
            qty: qtys[i],
            unitPrice: UNIT,
            subtotal: qtys[i] * UNIT,
          } as any,
        });
        lines.push({ productId: product.id, name, qty: qtys[i], orderItemId: oi.id });
      }
      return { id: order.id, lines };
    }

    /** A SENT, unpaid invoice of `orderId` (or of no order) carrying `lines`; `taxPct` is invoice-level tax. */
    async function invoice(
      fx: Fx,
      orderId: string | null,
      lines: Line[],
      taxPct = 0,
    ): Promise<Inv> {
      invSeq += 1;
      const base = lines.reduce((t, l) => t + l.qty * UNIT, 0);
      const tax = (base * taxPct) / 100;
      const inv = await prisma.invoice.create({
        data: {
          tenantId: fx.tenantId,
          customerId: fx.customerId,
          orderId,
          invoiceNumber: `INV-I192-${RUN}-${invSeq}`,
          status: "SENT",
          subtotal: base,
          taxAmount: tax,
          discount: 0,
          total: base + tax,
        },
      });
      const out: Inv = { id: inv.id, lines: [] };
      for (const l of lines) {
        const it = await prisma.invoiceItem.create({
          data: {
            tenantId: fx.tenantId,
            invoiceId: inv.id,
            orderItemId: l.orderItemId,
            productId: l.productId,
            description: l.name,
            qty: l.qty,
            unitPrice: UNIT,
            subtotal: l.qty * UNIT,
          } as any,
        });
        out.lines.push({ id: it.id, productId: l.productId });
      }
      return out;
    }

    /** The real refund path on a never-invoiced order: a STANDARD return of `qty` of `line`, refunded as a credit note. */
    async function refundNeverInvoiced(
      fx: Fx,
      orderId: string,
      line: Line,
      qty = 1,
    ): Promise<{ returnId: string; noteId: string }> {
      const ret = (await tenantCtx.run(fx.tenantId, () =>
        returns.create(
          { orderId, reason: "DAMAGED", items: [{ productId: line.productId, qty }] } as any,
          fx.userId,
        ),
      )) as { id: string };
      await prisma.return.update({ where: { id: ret.id }, data: { status: "RECEIVED" } });
      await tenantCtx.run(fx.tenantId, () =>
        returns.processRefund(ret.id, { method: "CREDIT_NOTE" } as any),
      );
      const row = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
      const note = await prisma.creditNote.findUniqueOrThrow({ where: { id: row.creditNoteId! } });
      // the shape under test: an ISSUED itemless note linked to neither an invoice nor an order
      expect(note.invoiceId).toBeNull();
      expect(note.status).toBe("ISSUED");
      expect(await prisma.creditNoteItem.count({ where: { creditNoteId: note.id } })).toBe(0);
      expect(await prisma.orderCreditNote.count({ where: { creditNoteId: note.id } })).toBe(0);
      return { returnId: ret.id, noteId: note.id };
    }

    const liveNotes = (fx: Fx) =>
      prisma.creditNote.count({ where: { tenantId: fx.tenantId, status: { not: "VOID" } } });

    /** A typed (itemised) credit note on one invoice line, through the real service. */
    async function typed(fx: Fx, invoiceId: string, itemId: string, amount: number) {
      try {
        const cn = (await tenantCtx.run(fx.tenantId, () =>
          creditNotes.create({
            customerId: fx.customerId,
            invoiceId,
            amount,
            items: [{ invoiceItemId: itemId, amount }],
          } as any),
        )) as { amount: unknown };
        return { allowed: true as const, amount: Number(cn.amount) };
      } catch (e: any) {
        return {
          allowed: false as const,
          code: e?.getResponse?.()?.code,
          message: String(e?.message),
        };
      }
    }

    /** A lump staff credit note (no line items): the invoice-total cap was its only check before SA-1053 rule 3c. */
    async function lump(fx: Fx, invoiceId: string, amount: number) {
      try {
        const cn = (await tenantCtx.run(fx.tenantId, () =>
          creditNotes.create({ customerId: fx.customerId, invoiceId, amount } as any),
        )) as { amount: unknown };
        return { allowed: true as const, amount: Number(cn.amount) };
      } catch (e: any) {
        return {
          allowed: false as const,
          code: e?.getResponse?.()?.code,
          message: String(e?.message),
        };
      }
    }

    const refused = (r: Awaited<ReturnType<typeof typed>>) => {
      expect(r.allowed).toBe(false);
      expect((r as { code?: string }).code).toBe(API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM);
    };

    /** What the shared single-invoice reader says is credited on one invoice line. */
    async function readCredited(fx: Fx, inv: Inv, itemId: string) {
      const rows = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      const lines = rows.map((r) => toHeadroomLine({ ...r, product: { unitsPerBox: null } }));
      const map = await tenantCtx.run(fx.tenantId, () =>
        loadLineCredits(prisma.forTenant(), inv.id, lines),
      );
      return map.get(itemId) ?? { amount: 0, qty: 0 };
    }

    it("R-N1: one invoice — a typed credit of the line's full value after the pre-invoice refund is refused", async () => {
      const fx = await mkFx("rn1");
      const order = await mkOrder(fx, ["X"]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const inv = await invoice(fx, order.id, order.lines);
      const before = await liveNotes(fx);
      refused(await typed(fx, inv.id, inv.lines[0].id, 100));
      expect(await liveNotes(fx)).toBe(before);
    });

    it("R-N2 / G-N6: two-line order — refused on the refunded line X, allowed on the other line Y", async () => {
      const fx = await mkFx("rn2");
      const order = await mkOrder(fx, ["X", "Y"]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const inv = await invoice(fx, order.id, order.lines);
      const before = await liveNotes(fx);
      refused(await typed(fx, inv.id, inv.lines[0].id, 100));
      expect(await liveNotes(fx)).toBe(before);
      const y = await typed(fx, inv.id, inv.lines[1].id, 100);
      expect(y).toEqual({ allowed: true, amount: 100 });
    });

    it("R-N3: 10% tax on the invoice — the credit on the refunded line is refused", async () => {
      const fx = await mkFx("rn3");
      const order = await mkOrder(fx, ["X"]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const inv = await invoice(fx, order.id, order.lines, 10);
      const before = await liveNotes(fx);
      refused(await typed(fx, inv.id, inv.lines[0].id, 100));
      expect(await liveNotes(fx)).toBe(before);
    });

    it("R-N5: X invoiced on A, Y on B (the order pool) — a typed credit on X at A is refused", async () => {
      const fx = await mkFx("rn5");
      const order = await mkOrder(fx, ["X", "Y"]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const a = await invoice(fx, order.id, [order.lines[0]]);
      await invoice(fx, order.id, [order.lines[1]]);
      const before = await liveNotes(fx);
      refused(await typed(fx, a.id, a.lines[0].id, 100));
      expect(await liveNotes(fx)).toBe(before);
    });

    /** A real inline capture (staff, STORE_CREDIT) of `pieces` of the order's product X; returns the error or undefined. */
    let keySeq = 0;
    async function inlineCapture(fx: Fx, orderId: string, productId: string, pieces: number) {
      const user = {
        sub: fx.userId,
        username: "operator",
        role: "OPERATOR" as any,
        status: "ACTIVE" as any,
        forcePasswordChange: false,
        tenantId: fx.tenantId,
        tenantSlug: "x",
      };
      try {
        await tenantCtx.run(fx.tenantId, () =>
          inline.capture(
            {
              customerId: fx.customerId,
              orderId,
              items: [
                { productId, qty: pieces, boxes: 0, pieces, alreadyReturnedReason: "i192 test" },
              ],
              returnKey: `i192-${RUN}-${++keySeq}`,
              resolution: "STORE_CREDIT",
            },
            user,
          ),
        );
        return undefined;
      } catch (e: any) {
        return {
          code: e?.getResponse?.()?.code,
          message: String(e?.getResponse?.()?.message ?? e?.message),
        };
      }
    }

    /** X (qty 2) billed 1 + 1 on invoices A and B, after 1 unit was refunded on a never-invoiced order: 1 unit is still owed. */
    async function twoInvoiceOwedUnit(label: string) {
      const fx = await mkFx(label);
      const order = await mkOrder(fx, ["X"], [2]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const one = { ...order.lines[0], qty: 1 };
      const a = await invoice(fx, order.id, [one]);
      const b = await invoice(fx, order.id, [one]);
      return { fx, order, a, b };
    }

    it("R-A1: X billed on A and B, 1 unit refunded before invoicing — an inline capture of the 1 owed unit is allowed by line", async () => {
      const { fx, order } = await twoInvoiceOwedUnit("ra1");
      // the real inline capture (entry: assertWithinLineHeadroom): refused on each invoice before A-1 (a false refusal of an owed unit)
      const err = await inlineCapture(fx, order.id, order.lines[0].productId, 1);
      console.info(`SA1053 OBSERVED ${JSON.stringify({ case: "ra1-capture", err: err ?? null })}`);
      expect(err).toBeUndefined();
    }, 60_000);

    it("R-A1b: the single-invoice reader does not replay the order's unlinked refund onto either of 2+ creditable invoices", async () => {
      const { fx, a, b } = await twoInvoiceOwedUnit("ra1b");
      expect(await readCredited(fx, a, a.lines[0].id)).toEqual({ amount: 0, qty: 0 });
      expect(await readCredited(fx, b, b.lines[0].id)).toEqual({ amount: 0, qty: 0 });
    }, 60_000);

    it("G-A2: the order pool still counts the refunded unit once — 1 owed unit fits, a 2nd does not", async () => {
      const { fx, order } = await twoInvoiceOwedUnit("ga2");
      const pool = await tenantCtx.run(fx.tenantId, () =>
        loadOrderPool(prisma.forTenant(), order.id),
      );
      const credited = [...pool.credited.values()].reduce((t, c) => t + c.qty, 0);
      console.info(`SA1053 OBSERVED ${JSON.stringify({ case: "ga2", creditedQty: credited })}`);
      expect(credited).toBe(1); // once across both invoices, not once per invoice
      const productId = order.lines[0].productId;
      expect(pooledTakeRefusal(pool, productId, { amount: 100, qty: 1 })).toBeNull();
      expect(pooledTakeRefusal(pool, productId, { amount: 200, qty: 2 })).not.toBeNull();
    }, 60_000);

    it("G-N7: an invoice with no order is unchanged — the credit is allowed", async () => {
      const fx = await mkFx("gn7");
      const order = await mkOrder(fx, ["X"]);
      const inv = await invoice(fx, null, order.lines);
      expect(await typed(fx, inv.id, inv.lines[0].id, 100)).toEqual({ allowed: true, amount: 100 });
    });

    it("G-N8: ANOTHER order's refund lump queued to this order is not attributed to this order's lines", async () => {
      const fx = await mkFx("gn8");
      const other = await mkOrder(fx, ["O"]);
      const { noteId } = await refundNeverInvoiced(fx, other.id, other.lines[0]);
      const order = await mkOrder(fx, ["X"]);
      await prisma.orderCreditNote.create({
        data: { tenantId: fx.tenantId, orderId: order.id, creditNoteId: noteId, amount: 100 },
      });
      const inv = await invoice(fx, order.id, order.lines);
      expect(await typed(fx, inv.id, inv.lines[0].id, 100)).toEqual({ allowed: true, amount: 100 });
    });

    it("G-N9: a VOID unlinked refund note is not counted", async () => {
      const fx = await mkFx("gn9");
      const order = await mkOrder(fx, ["X"]);
      const { noteId } = await refundNeverInvoiced(fx, order.id, order.lines[0]);
      await prisma.creditNote.update({ where: { id: noteId }, data: { status: "VOID" } });
      const inv = await invoice(fx, order.id, order.lines);
      expect(await typed(fx, inv.id, inv.lines[0].id, 100)).toEqual({ allowed: true, amount: 100 });
    });

    it("G-N10: an INLINE return's note is counted once (by the inline term), not twice", async () => {
      const fx = await mkFx("gn10");
      const order = await mkOrder(fx, ["X"]);
      const inv = await invoice(fx, order.id, order.lines);
      const note = await prisma.creditNote.create({
        data: {
          tenantId: fx.tenantId,
          customerId: fx.customerId,
          creditNoteNumber: `CN-I192-${RUN}-inline`,
          amount: 100,
          status: "ISSUED",
        },
      });
      const ret = await prisma.return.create({
        data: {
          tenantId: fx.tenantId,
          orderId: order.id,
          customerId: fx.customerId,
          reason: "DAMAGED",
          status: "REFUNDED",
          kind: "INLINE",
          creditNoteId: note.id,
        },
      });
      await prisma.returnItem.create({
        data: {
          tenantId: fx.tenantId,
          returnId: ret.id,
          productId: order.lines[0].productId,
          qty: 1,
          sourceInvoiceItemId: inv.lines[0].id,
          subtotal: 100,
        },
      });
      expect(await readCredited(fx, inv, inv.lines[0].id)).toMatchObject({ amount: 100, qty: 1 });
    });

    it("G-N11: a refund minted ON an invoice is counted once", async () => {
      const fx = await mkFx("gn11");
      const order = await mkOrder(fx, ["X"]);
      const inv = await invoice(fx, order.id, order.lines);
      const note = await prisma.creditNote.create({
        data: {
          tenantId: fx.tenantId,
          customerId: fx.customerId,
          invoiceId: inv.id,
          creditNoteNumber: `CN-I192-${RUN}-onInv`,
          amount: 100,
          status: "ISSUED",
        },
      });
      const ret = await prisma.return.create({
        data: {
          tenantId: fx.tenantId,
          orderId: order.id,
          customerId: fx.customerId,
          reason: "DAMAGED",
          status: "REFUNDED",
          creditNoteId: note.id,
        },
      });
      await prisma.returnItem.create({
        data: {
          tenantId: fx.tenantId,
          returnId: ret.id,
          productId: order.lines[0].productId,
          qty: 1,
        },
      });
      expect(await readCredited(fx, inv, inv.lines[0].id)).toMatchObject({ amount: 100, qty: 1 });
    });

    it("G-N13: R-N5's order after staff queue the unlinked note to it — counted once (room stays exactly 100.00)", async () => {
      const fx = await mkFx("gn13");
      // X is 2 x 100.00 on A, Y 1 x 100.00 on B; 1 of X was refunded (100.00) before invoicing
      const order = await mkOrder(fx, ["X", "Y"], [2, 1]);
      const { noteId } = await refundNeverInvoiced(fx, order.id, order.lines[0], 1);
      const note = await prisma.creditNote.findUniqueOrThrow({ where: { id: noteId } });
      expect(Number(note.amount)).toBe(100);
      await prisma.orderCreditNote.create({
        data: { tenantId: fx.tenantId, orderId: order.id, creditNoteId: noteId, amount: 100 },
      });
      const a = await invoice(fx, order.id, [order.lines[0]]);
      await invoice(fx, order.id, [order.lines[1]]);
      expect(await typed(fx, a.id, a.lines[0].id, 100)).toEqual({ allowed: true, amount: 100 });
      refused(await typed(fx, a.id, a.lines[0].id, 100));
    });

    it("R-N4: one invoice — a lump staff note (no line items) past what the order was billed is refused", async () => {
      const fx = await mkFx("rn4");
      const order = await mkOrder(fx, ["X"]);
      await refundNeverInvoiced(fx, order.id, order.lines[0]);
      const inv = await invoice(fx, order.id, order.lines);
      const before = await liveNotes(fx);
      const r = await lump(fx, inv.id, 100);
      refused(r);
      expect((r as { message: string }).message).toContain("already refunded as store credit");
      expect(await liveNotes(fx)).toBe(before);
    });

    it("G-N14: a lump staff note inside the order's remaining room is allowed; the one past it is refused", async () => {
      const fx = await mkFx("gn14");
      // X is 2 x 100.00; 1 was refunded (100.00) before invoicing, so 100.00 of the 200.00 billed is left
      const order = await mkOrder(fx, ["X"], [2]);
      await refundNeverInvoiced(fx, order.id, order.lines[0], 1);
      const inv = await invoice(fx, order.id, order.lines);
      expect(await lump(fx, inv.id, 100)).toEqual({ allowed: true, amount: 100 });
      refused(await lump(fx, inv.id, 0.02));
    });
  },
);
