/**
 * HIGH money bug (F2-confirmed): a line can be credited past its value by combining a CREDIT NOTE with a RETURN REFUND.
 * On a 2-line $200 invoice, line A ($100) can be credited $133.33: a $33.33 credit note on A, then a full return refund of A
 * ($100). The returns refund mints an ITEMLESS lump-sum credit note that `ReturnsService.billedBasisFor` checks only against
 * INVOICE headroom, while the credit-note per-line cap (`CreditNotesService.create`, `priorForLine`) counts only item-bearing
 * notes, so neither side sees the other.
 *
 * SA-628 ruled REFUSE (409 RETURN_REFUND_OVER_LINE_HEADROOM), never clip: a refund that would take a line past its value is refused
 * BEFORE the claim; a credit note past it is the existing 400. Cases 1/2/4/5/8 assert the INVARIANT, "the total credited against a line
 * (CN items on it + refunds of returns of its product) never exceeds the line's value". Cases 3 (partial boundary), 6 (VOID
 * frees headroom) and 7 (itemless manual credits stay invoice-level only) pin the ruling's edges.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway `qa-capret-<run>-<n>` slug
 * approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "a line is never credited past its value across credit notes AND return refunds — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    let returns: ReturnsService;
    let inline: any;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;
    let rtnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      // The socket gateway: nothing under test. NEVER answer `then` (or a symbol): Nest would await the proxy as a thenable and hang.
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
              reserveNext: jest.fn().mockImplementation(async () => `CN-CAPRET-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      creditNotes = mod.get(CreditNotesService);
      returns = mod.get(ReturnsService);
      // B948: a REAL InlineReturnsService (same Object.create wiring as inline-returns-capture-concurrency.db.spec.ts)
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      inline = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: anyMethod,
        ledger: mod.get(RegulatedLedgerService),
        creditNotes,
        numbering: {
          reserveNext: jest.fn().mockImplementation(async () => `RTN-CAPRET-${RUN}-I${++rtnSeq}`),
        },
        addonService: { hasAddon: async () => true },
        quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
        idempotency: new IdempotencyService(),
      });
    });

    afterAll(async () => {
      const swallow = () => undefined; // a failed cleanup must never mask a test's result
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

    /**
     * A SENT 2-line invoice: A = $100 and B = $100 (subtotals). `taxPct` > 0 adds that % of tax per line at the INVOICE level
     * (so a line's value including tax is 100 * (1 + taxPct/100)).
     */
    async function seed(label: string, taxPct = 0, qtyA = 1, freeA = false) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-capret-${RUN}-${seq}-${label}`,
        "credit-return-line-cap.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `cap ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const mk = (name: string) =>
        prisma.product.create({
          data: { tenantId, name: `${name} ${slug}`, unit: "each", pricePerUnit: 100 },
        });
      const [pA, pB] = [await mk("A"), await mk("B")];
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-CAPRET-${RUN}-${seq}`,
          subtotal: freeA ? 100 : 200,
          tax: 0,
          total: freeA ? 100 : 200,
          status: "DELIVERED",
        } as any,
      });
      for (const p of [pA, pB]) {
        const qty = p === pA ? qtyA : 1;
        await prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: p.id,
            name: p.name,
            qty,
            unitPrice: p === pA && freeA ? 0 : 100 / qty,
            subtotal: p === pA && freeA ? 0 : 100,
          } as any,
        });
      }
      const base = freeA ? 100 : 200;
      const tax = (base * taxPct) / 100;
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-CAPRET-${RUN}-${seq}`,
          status: "SENT",
          subtotal: base,
          taxAmount: tax,
          total: base + tax,
        },
      });
      const item = (productId: string, description: string) => {
        const qty = productId === pA.id ? qtyA : 1;
        return prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            productId,
            description,
            qty,
            unitPrice: productId === pA.id && freeA ? 0 : 100 / qty,
            subtotal: productId === pA.id && freeA ? 0 : 100,
          },
        });
      };
      const [lineA, lineB] = [await item(pA.id, "A"), await item(pB.id, "B")];
      return {
        userId: user.id,
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceId: invoice.id,
        pA,
        pB,
        lineA,
        lineB,
        taxPct,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    /** A RECEIVED, whole-line return of `productId` (qty 1 = the full line). */
    async function receivedReturn(s: Seed, productId: string, qty = 1) {
      rtnSeq += 1;
      return prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          customerId: s.customerId,
          reason: "DAMAGED",
          status: "RECEIVED",
          returnNumber: `RTN-CAPRET-${RUN}-${rtnSeq}`,
          items: { create: [{ tenantId: s.tenantId, productId, qty }] },
        } as any,
      });
    }
    const inTenant = <T>(s: Seed, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
    const creditNoteItem = (s: Seed, line: { id: string }, amount: number) =>
      inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount,
          items: [{ invoiceItemId: line.id, amount }],
        } as any),
      );
    const refund = (s: Seed, returnId: string) =>
      inTenant(s, () => returns.processRefund(returnId));

    /** CN items booked on a line (non-VOID) + refunds of REFUNDED returns of the line's product (their itemless credit notes). */
    async function creditedOnLine(
      s: Seed,
      line: { id: string },
      productId: string,
    ): Promise<number> {
      const items = await prisma.creditNoteItem.findMany({
        where: {
          tenantId: s.tenantId,
          invoiceItemId: line.id,
          creditNote: { status: { not: "VOID" } },
        },
        select: { amount: true },
      });
      // A refund is counted ONCE: an ITEMISED refund note is already in `items` above; only a legacy ITEMLESS refund note
      // (master before SA-628) is counted through its return's refundAmount.
      const itemlessNotes = await prisma.creditNote.findMany({
        where: { tenantId: s.tenantId, status: { not: "VOID" }, items: { none: {} } },
        select: { id: true },
      });
      const refunded = await prisma.return.findMany({
        where: {
          tenantId: s.tenantId,
          status: "REFUNDED",
          creditNoteId: { in: itemlessNotes.map((n) => n.id) },
          items: { some: { productId } },
        },
        select: { refundAmount: true },
      });
      return (
        Math.round(
          (items.reduce((n, i) => n + Number(i.amount), 0) +
            refunded.reduce((n, r) => n + Number(r.refundAmount ?? 0), 0)) *
            100,
        ) / 100
      );
    }
    const lineValue = (s: Seed) => Math.round(100 * (1 + s.taxPct / 100) * 100) / 100;
    const attempt = (p: Promise<unknown>) => p.catch((e) => e); // refuse OR clip: the invariant holds either way

    it("1. RED REPRO: a $33.33 credit note on A then a FULL return refund of A can never total more than A's value", async () => {
      const s = await seed("cn-then-return");
      await creditNoteItem(s, s.lineA, 33.33);
      await attempt(refund(s, (await receivedReturn(s, s.pA.id)).id));
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(lineValue(s)); // today: 133.33
    });

    it("2. reverse order: a full return refund of A first, then a $33.33 credit note on A, never totals more than A's value", async () => {
      const s = await seed("return-then-cn");
      await refund(s, (await receivedReturn(s, s.pA.id)).id);
      await attempt(creditNoteItem(s, s.lineA, 33.33));
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(lineValue(s)); // today: 133.33
    });

    it("4. multi-line: A cannot borrow B's slack (the invoice total has room), and B stays creditable in full", async () => {
      const s = await seed("multi-line");
      await creditNoteItem(s, s.lineA, 100); // A fully credited by a credit note
      await attempt(refund(s, (await receivedReturn(s, s.pA.id)).id)); // a return of A on top: over-credits A from B's slack
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(lineValue(s));
      await expect(creditNoteItem(s, s.lineB, 100)).resolves.toBeDefined(); // B untouched, still fully creditable
    });

    it("5. tax share: with 10% tax a line is worth $110; credit note + return refund together never exceed $110", async () => {
      const s = await seed("tax", 10);
      await creditNoteItem(s, s.lineA, 60);
      await attempt(refund(s, (await receivedReturn(s, s.pA.id)).id));
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(lineValue(s)); // 110.00
    });

    it("8. concurrency: a credit note and a return refund racing on the SAME line never total more than its value, and neither 500s", async () => {
      const s = await seed("race");
      const ret = await receivedReturn(s, s.pA.id);
      const results = await Promise.allSettled([creditNoteItem(s, s.lineA, 60), refund(s, ret.id)]);
      for (const r of results) {
        if (r.status === "rejected") {
          // a refusal is a 4xx (BadRequest / Conflict); a raw serialization / deadlock error would surface as a 500
          expect((r.reason as { getStatus?: () => number }).getStatus?.()).toBeLessThan(500);
        }
      }
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(lineValue(s));
    });

    it("3. partial boundary: 4 of 10 pieces returned (= $40), then a credit note of exactly the remaining $60.00 is allowed and $60.01 is refused", async () => {
      const s = await seed("partial", 0, 10);
      await refund(s, (await receivedReturn(s, s.pA.id, 4)).id);
      await expect(creditNoteItem(s, s.lineA, 60.01)).rejects.toBeDefined();
      await expect(creditNoteItem(s, s.lineA, 60)).resolves.toBeDefined();
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBe(100);
    });

    it("3b. credit note first ($60), then a return of 4 pieces is allowed and a return of 5 is REFUSED 409 RETURN_REFUND_OVER_LINE_HEADROOM", async () => {
      const s = await seed("partial2", 0, 10);
      await creditNoteItem(s, s.lineA, 60);
      const overReturn = await receivedReturn(s, s.pA.id, 5);
      const over = await refund(s, overReturn.id).catch((e) => e);
      expect(over?.getResponse?.()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
      // SA-773: a RECEIVED return reserves its goods (fail closed), so the office rejects the refused one before the smaller refunds
      await prisma.return.update({ where: { id: overReturn.id }, data: { status: "REJECTED" } });
      await expect(refund(s, (await receivedReturn(s, s.pA.id, 4)).id)).resolves.toBeDefined();
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBe(100);
    });

    it("6. VOID frees the headroom: a refused refund succeeds after the blocking credit note is voided", async () => {
      const s = await seed("void");
      const cn = await creditNoteItem(s, s.lineA, 100);
      const ret = await receivedReturn(s, s.pA.id);
      await expect(refund(s, ret.id)).rejects.toBeDefined();
      await inTenant(s, () => creditNotes.voidWithReversal(cn.id, null));
      await expect(refund(s, ret.id)).resolves.toBeDefined();
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBe(100);
    });

    it("7. a manual ITEMLESS credit note stays invoice-level only (no pro-rata onto lines): it does not block a return of A while the invoice total has room", async () => {
      const s = await seed("itemless");
      await inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount: 100,
        } as any),
      );
      await expect(refund(s, (await receivedReturn(s, s.pA.id)).id)).resolves.toBeDefined(); // 100 + 100 <= 200
      await expect(creditNoteItem(s, s.lineB, 100)).rejects.toBeDefined(); // the INVOICE total still caps the sum
    });

    it("9. SA-628a B1: a FREE ($0) line is refunded at amount 0 (not refused); the paid line next to it is untouched and creditable", async () => {
      const s = await seed("free", 0, 2, true);
      const ret = await receivedReturn(s, s.pA.id, 1);
      await expect(refund(s, ret.id)).resolves.toBeDefined(); // all-free refund: return REFUNDED, no credit note
      const notes = await prisma.creditNote.count({ where: { tenantId: s.tenantId } });
      expect(notes).toBe(0);
      expect((await prisma.return.findUnique({ where: { id: ret.id } }))?.status).toBe("REFUNDED");
      await expect(creditNoteItem(s, s.lineB, 100)).resolves.toBeDefined();
    });

    it("10. SA-628a B2: qty is left but the MONEY is short ($100/10pc, $50 credited as 1pc, 9 pcs back = $90) is REFUSED 409 with {requested, remaining}", async () => {
      const s = await seed("moneyshort", 0, 10);
      await inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount: 50,
          items: [{ invoiceItemId: s.lineA.id, amount: 50, qty: 1 }],
        } as any),
      );
      const err = await refund(s, (await receivedReturn(s, s.pA.id, 9)).id).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({
        code: "RETURN_REFUND_OVER_LINE_HEADROOM",
        requested: 90,
        remaining: 50,
      });
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBe(50); // nothing minted
    });

    it("11. SA-628a (a): a legacy itemless refund note counts through its return LINK whatever the return status (PROCESSED too)", async () => {
      const s = await seed("legacy-processed");
      const cn = await inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount: 100,
        } as any),
      );
      const ret = await receivedReturn(s, s.pA.id, 1);
      await prisma.return.update({
        where: { id: ret.id },
        data: { status: "PROCESSED", creditNoteId: cn.id } as any,
      });
      // line A is fully consumed by the legacy refund: a $1 item credit on A must be refused (the invoice total has room)
      await expect(creditNoteItem(s, s.lineA, 1)).rejects.toBeDefined();
      await expect(creditNoteItem(s, s.lineB, 100)).resolves.toBeDefined();
    });

    it("12. SA-628b: money-neutral vs master: 1 free + 10 paid ($100), a 1-pc return refunds the pooled $9.09, itemised on the PAID line; the free line is untouched", async () => {
      const s = await seed("pooled", 0, 10);
      const free = await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceId,
          productId: s.pA.id,
          description: "A free",
          qty: 1,
          unitPrice: 0,
          subtotal: 0,
        },
      });
      const ret = await receivedReturn(s, s.pA.id, 1);
      await refund(s, ret.id);
      const stored = await prisma.return.findUnique({ where: { id: ret.id } });
      const cn = await prisma.creditNote.findFirstOrThrow({
        where: { id: stored!.creditNoteId! },
        include: { items: true },
      });
      expect(Number(cn.amount)).toBe(9.09);
      expect(cn.items.map((i) => [i.invoiceItemId, Number(i.amount)])).toEqual([
        [s.lineA.id, 9.09],
      ]);
      expect(cn.items.some((i) => i.invoiceItemId === free.id)).toBe(false);
    });

    it("13. SA-628b FOLD1: a prior $9 / 9-pc credit on a $100/10pc line, then a 1-pc return mints $10 (the pooled price), never the $91 rest", async () => {
      const s = await seed("closing", 0, 10);
      await inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount: 9,
          items: [{ invoiceItemId: s.lineA.id, amount: 9, qty: 9 }],
        } as any),
      );
      const ret = await receivedReturn(s, s.pA.id, 1);
      await refund(s, ret.id);
      const stored = await prisma.return.findUnique({ where: { id: ret.id } });
      const cn = await prisma.creditNote.findFirstOrThrow({ where: { id: stored!.creditNoteId! } });
      expect(Number(cn.amount)).toBe(10);
    });

    it("14. SA-628b FOLD1: a prior 3 pcs @ $5 on a $100/10 line, then a 7-pc return mints $70 (the pooled price), never the $85 rest", async () => {
      const s = await seed("closing7", 0, 10);
      await inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount: 15,
          items: [{ invoiceItemId: s.lineA.id, amount: 15, qty: 3 }],
        } as any),
      );
      const ret = await receivedReturn(s, s.pA.id, 7);
      await refund(s, ret.id);
      const stored = await prisma.return.findUnique({ where: { id: ret.id } });
      const cn = await prisma.creditNote.findFirstOrThrow({ where: { id: stored!.creditNoteId! } });
      expect(Number(cn.amount)).toBe(70);
      expect(await creditedOnLine(s, s.lineA, s.pA.id)).toBeLessThanOrEqual(100);
    });

    /** An inline return of `qty` pieces of A, captured onto a fresh DELIVERED carrying order (an operator, no driver cap). */
    async function inlineReturn(s: Seed, qty = 1, alreadyReturnedReason?: string) {
      const carrying = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderNumber: `ORD-CAPRET-${RUN}-C${++rtnSeq}`,
          subtotal: 0,
          tax: 0,
          total: 0,
          status: "DELIVERED",
        } as any,
      });
      return tenantCtx.run(s.tenantId, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: carrying.id,
            items: [
              {
                productId: s.pA.id,
                qty,
                ...(alreadyReturnedReason ? { alreadyReturnedReason } : {}),
              },
            ],
            returnKey: `capret-${RUN}-${rtnSeq}`,
          },
          {
            sub: s.userId,
            username: "operator",
            role: "OPERATOR" as any,
            status: "ACTIVE" as any,
            forcePasswordChange: false,
            tenantId: s.tenantId,
            tenantSlug: "x",
          },
        ),
      );
    }
    /** CN items on the line + the net subtotal of live inline returns sourced from it. */
    async function creditedWithInline(s: Seed, line: { id: string }): Promise<number> {
      const items = await prisma.creditNoteItem.findMany({
        where: {
          tenantId: s.tenantId,
          invoiceItemId: line.id,
          creditNote: { status: { not: "VOID" } },
        },
        select: { amount: true },
      });
      const ret = await prisma.returnItem.findMany({
        where: {
          tenantId: s.tenantId,
          sourceInvoiceItemId: line.id,
          return: { kind: "INLINE", status: { notIn: ["CANCELLED", "REJECTED"] } },
        },
        select: { subtotal: true },
      });
      return (
        Math.round(
          (items.reduce((n, i) => n + Number(i.amount), 0) +
            ret.reduce((n, r) => n + Number(r.subtotal ?? 0), 0)) *
            100,
        ) / 100
      );
    }

    it("15. B948: a $60 credit note item on A, then an inline return of the whole $100 line is REFUSED 409 (was $160 on a $100 line)", async () => {
      const s = await seed("cn-then-inline");
      await creditNoteItem(s, s.lineA, 60);
      const err = await inlineReturn(s).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
      expect(await creditedWithInline(s, s.lineA)).toBeLessThanOrEqual(100);
    });

    it("16. B948 reverse order: an inline return of the whole line first, then a $60 credit note item on A is refused; B stays creditable", async () => {
      const s = await seed("inline-then-cn");
      await inlineReturn(s);
      await expect(creditNoteItem(s, s.lineA, 60)).rejects.toBeDefined();
      expect(await creditedWithInline(s, s.lineA)).toBeLessThanOrEqual(100);
      await expect(creditNoteItem(s, s.lineB, 100)).resolves.toBeDefined();
    });

    it("17. B948: a $60 credit note then an inline return of the remaining 0.4 of a 10-piece line fits; one piece more is refused", async () => {
      const s = await seed("inline-partial", 0, 10);
      await creditNoteItem(s, s.lineA, 60); // 6 pieces' worth
      await expect(inlineReturn(s, 4)).resolves.toBeDefined();
      const err = await inlineReturn(s, 1).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
      expect(await creditedWithInline(s, s.lineA)).toBeLessThanOrEqual(100);
    });

    it("18. B948 race: a $60 credit note item and an inline return of the whole line racing on A never total more than $100, and neither 500s", async () => {
      const s = await seed("race-inline");
      const results = await Promise.allSettled([creditNoteItem(s, s.lineA, 60), inlineReturn(s)]);
      for (const r of results) {
        if (r.status === "rejected") {
          expect((r.reason as { getStatus?: () => number }).getStatus?.()).toBeLessThan(500);
        }
      }
      expect(await creditedWithInline(s, s.lineA)).toBeLessThanOrEqual(100);
    });

    /** The F2 repro: A is billed on invoice X only; the order also has a LATER invoice Y, so a standard return's refund of A is a
     *  lump sum on Y (2+ creditable invoices) and X's line A is never touched. */
    async function refundedOnLaterInvoice(label: string) {
      const s = await seed(label);
      await prisma.invoice.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderId: s.orderId,
          invoiceNumber: `INV-CAPRET-${RUN}-Y${++rtnSeq}`,
          status: "SENT",
          // Y must have room for A's whole $100 refund (the lump sum lands here), or the standard refund is refused and the
          // precondition is never built (F2's finding on the first push)
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          items: {
            create: [
              {
                tenantId: s.tenantId,
                productId: s.pB.id,
                description: "B later",
                qty: 1,
                unitPrice: 100,
                subtotal: 100,
              },
            ],
          },
        } as any,
      });
      await refund(s, (await receivedReturn(s, s.pA.id)).id); // the standard refund of A (lump sum on Y)
      return s;
    }
    const inlineCredits = (s: Seed) =>
      prisma.creditNote.count({
        where: { tenantId: s.tenantId, invoiceId: null, items: { none: {} } },
      });

    const staffUser = (s: Seed) => ({
      sub: s.userId,
      username: "operator",
      role: "OPERATOR" as any,
      status: "ACTIVE" as any,
      forcePasswordChange: false,
      tenantId: s.tenantId,
      tenantSlug: "x",
    });
    /** All credit-note money minted for this tenant (the lump refund + any inline credit). */
    const totalCredited = async (s: Seed) =>
      Number(
        (
          await prisma.creditNote.aggregate({
            where: { tenantId: s.tenantId, status: { not: "VOID" } },
            _sum: { amount: true },
          })
        )._sum.amount ?? 0,
      );

    it("21. B961 (F2 repro, SA-071d): A already refunded by a STANDARD return (lump on a later invoice); an inline return of A is an UNREFERENCED chunk flagged 'already returned or credited', never auto-credited: staff need a reason", async () => {
      const s = await refundedOnLaterInvoice("ar-staff");
      expect(await totalCredited(s)).toBe(100); // the standard refund of A, once
      // (1)+(2): the quote prices it unreferenced (no source line) and flags it
      const quote = await tenantCtx.run(s.tenantId, () =>
        inline.quoteService.quote(
          { customerId: s.customerId, items: [{ productId: s.pA.id, boxes: 0, pieces: 1 }] },
          staffUser(s),
        ),
      );
      expect(quote.chunks).toHaveLength(1);
      expect(quote.chunks[0]).toMatchObject({
        sourceInvoiceItemId: null,
        alreadyReturned: true,
      });
      expect(["CUSTOMER_PRICE", "TIER", "BASE"]).toContain(quote.chunks[0].priceSource);
      // (5): without the confirm nothing is credited: the total stays $100 on the $100 line
      const err = await inlineReturn(s).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({
        code: "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
      });
      expect(await totalCredited(s)).toBe(100);
      // (4): staff + a reason is allowed AND audited with the actor and the reason
      await inlineReturn(s, 1, "customer kept the original credit slip");
      const audit: any = await prisma.auditLog.findFirst({
        where: {
          tenantId: s.tenantId,
          action: "inline_return.already_returned_credit",
          userId: s.userId,
        },
      });
      expect(audit?.meta?.items?.[0]).toMatchObject({
        productId: s.pA.id,
        reason: "customer kept the original credit slip",
      });
      expect(await totalCredited(s)).toBe(200); // the deliberate, audited second credit
    });

    it("21b. B961 (SA-071d): the same capture by a DRIVER is HELD for the office: not credited, not restocked, audited", async () => {
      const s = await refundedOnLaterInvoice("ar-driver");
      const driverUser = await prisma.user.create({
        data: {
          email: `drv-${RUN}-${++rtnSeq}@example.invalid`,
          username: `drv-${RUN}-${rtnSeq}`,
          role: "DRIVER",
          tenantId: s.tenantId,
        },
      });
      const driver = await prisma.driver.create({
        data: { userId: driverUser.id, tenantId: s.tenantId },
      });
      const route = await prisma.route.create({
        data: { name: `r ${RUN} ${rtnSeq}`, tenantId: s.tenantId },
      });
      const routeStop = await prisma.routeStop.create({
        data: { routeId: route.id, stopNumber: 1, tenantId: s.tenantId },
      });
      const run = await prisma.routeRun.create({
        data: {
          routeId: route.id,
          driverId: driver.id,
          status: "IN_PROGRESS",
          scheduledDate: new Date(),
          tenantId: s.tenantId,
        },
      });
      const stop = await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: routeStop.id,
          customerId: s.customerId,
          stopNumber: 1,
          status: "IN_PROGRESS",
          podPhotoUrls: [],
          tenantId: s.tenantId,
        },
      });
      const carrying = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderNumber: `ORD-CAPRET-${RUN}-D${++rtnSeq}`,
          subtotal: 0,
          tax: 0,
          total: 1000,
          status: "DELIVERED",
          routeRunId: run.id,
          routeRunStopId: stop.id,
        } as any,
      });
      const held: any = await tenantCtx.run(s.tenantId, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: carrying.id,
            items: [{ productId: s.pA.id, qty: 1 }],
            routeRunStopId: stop.id,
            returnKey: `capret-${RUN}-D${rtnSeq}`,
          },
          {
            sub: driverUser.id,
            username: "driver",
            role: "DRIVER" as any,
            status: "ACTIVE" as any,
            forcePasswordChange: false,
            tenantId: s.tenantId,
            tenantSlug: "x",
          },
        ),
      );
      expect(held.status).toBe("RECEIVED");
      expect(held.holdReason).toBe("ALREADY_RETURNED"); // SA-071f: the hold lives in the column
      expect(held.creditNoteId ?? null).toBeNull();
      expect(String(held.holdMessage)).toMatch(/already returned or credited/i);
      expect(await totalCredited(s)).toBe(100); // never auto-credited
      expect(
        await prisma.auditLog.count({
          where: {
            tenantId: s.tenantId,
            action: "inline_return.already_returned_hold",
            entityId: held.id,
          },
        }),
      ).toBe(1);
    });

    it("22. B961: a product NEVER invoiced (not on any invoice) is unchanged: an inline return needs no reason", async () => {
      const s = await seed("ar-never");
      const lone = await prisma.product.create({
        data: { tenantId: s.tenantId, name: `lone ${RUN}`, unit: "each", pricePerUnit: 10 },
      });
      const carrying = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderNumber: `ORD-CAPRET-${RUN}-L${++rtnSeq}`,
          subtotal: 0,
          tax: 0,
          total: 0,
          status: "DELIVERED",
        } as any,
      });
      await expect(
        tenantCtx.run(s.tenantId, () =>
          inline.capture(
            {
              customerId: s.customerId,
              orderId: carrying.id,
              items: [{ productId: lone.id, qty: 1 }],
              returnKey: `capret-${RUN}-${rtnSeq}`,
            },
            {
              sub: s.userId,
              username: "operator",
              role: "OPERATOR" as any,
              status: "ACTIVE" as any,
              forcePasswordChange: false,
              tenantId: s.tenantId,
              tenantSlug: "x",
            },
          ),
        ),
      ).resolves.toBeDefined();
    });

    it("23. B961 / SA-071e: a product exhausted ONLY by credit notes (no return) is not flagged: it MATCHES the line, and the B948 line cap refuses the inline return 409", async () => {
      const s = await seed("cn-only-exhausted");
      await creditNoteItem(s, s.lineA, 100); // the whole line, credited by a credit note
      const quote = await tenantCtx.run(s.tenantId, () =>
        inline.quoteService.quote(
          { customerId: s.customerId, items: [{ productId: s.pA.id, boxes: 0, pieces: 1 }] },
          staffUser(s),
        ),
      );
      expect(quote.chunks[0]).toMatchObject({ sourceInvoiceItemId: s.lineA.id });
      expect(quote.chunks[0]).not.toHaveProperty("alreadyReturned");
      const err = await inlineReturn(s, 1, "should not matter").catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
    });

    /** The sale is 120 days old: outside the 90-day PRICING window, so the inline chunk is unreferenced either way; the FLAG
     *  (SA-071f) reads the customer's whole history. */
    const quoteInlineA = (s: Seed) =>
      tenantCtx.run(s.tenantId, () =>
        inline.quoteService.quote(
          { customerId: s.customerId, items: [{ productId: s.pA.id, boxes: 0, pieces: 1 }] },
          staffUser(s),
        ),
      );
    const ageInvoice = (s: Seed, days: number) =>
      prisma.invoice.update({
        where: { id: s.invoiceId },
        data: { issueDate: new Date(Date.now() - days * 86_400_000) },
      });

    it("24. B961 / SA-071f: a sale 120 days ago FULLY refunded, then an inline return today: unreferenced AND flagged (the old window would have missed it)", async () => {
      const s = await seed("ar-120d-refunded");
      await refund(s, (await receivedReturn(s, s.pA.id)).id);
      await ageInvoice(s, 120);
      const quote = await quoteInlineA(s);
      expect(quote.chunks).toHaveLength(1);
      expect(quote.chunks[0]).toMatchObject({ sourceInvoiceItemId: null, alreadyReturned: true });
    });

    it("25. B961 / SA-071f: a sale 120 days ago NOT returned: a legitimate old-purchase return, unreferenced and NOT flagged", async () => {
      const s = await seed("ar-120d-untouched");
      await ageInvoice(s, 120);
      const quote = await quoteInlineA(s);
      expect(quote.chunks[0]).toMatchObject({ sourceInvoiceItemId: null });
      expect(quote.chunks[0]).not.toHaveProperty("alreadyReturned");
    });

    it("26. B961 / SA-071f N3: a held flagged capture still demands the reason after its audit rows are DELETED (the hold is the holdReason column)", async () => {
      const s = await refundedOnLaterInvoice("ar-audit-pruned");
      const driverHold = await prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          customerId: s.customerId,
          reason: "DAMAGED",
          status: "RECEIVED",
          kind: "INLINE",
          holdReason: "ALREADY_RETURNED",
          heldAmount: 100,
          returnNumber: `RTN-CAPRET-${RUN}-P${++rtnSeq}`,
          items: { create: [{ tenantId: s.tenantId, productId: s.pA.id, qty: 1, subtotal: 100 }] },
        } as any,
      });
      await prisma.auditLog.deleteMany({
        where: { tenantId: s.tenantId, entityId: driverHold.id },
      });
      const err: any = await tenantCtx
        .run(s.tenantId, () => inline.approve(driverHold.id, staffUser(s)))
        .catch((e: unknown) => e);
      expect(err?.getResponse?.()).toMatchObject({
        code: "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
      });
    });
  },
);
