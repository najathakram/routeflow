/**
 * B947 (HIGH money, interim fix; real Postgres): a return refund on an order with 2+ creditable invoices is headroom-checked
 * against the order's invoice TOTALS and the LATEST invoice's room only, then minted as a lump sum on the latest invoice. The
 * per-line refund-mode check B946 (SA-628) added runs for a single creditable invoice only, so a line on an OLDER invoice can
 * be credited past its value: a credit note item on X's line A, then a return refund of A (lump sum on Y), totals 2 x A.
 *
 * The fix under test: the SAME refund-mode check across ALL creditable invoices' lines (a 409 RETURN_REFUND_OVER_LINE_HEADROOM,
 * refused BEFORE the claim, never clipped), the mint UNCHANGED (still a lump sum on the latest invoice, no items).
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-b947-<run>-<n>` slug approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
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
  "B947: a line is never credited past its value when a return refund spans 2+ creditable invoices: real Postgres",
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
              reserveNext: jest.fn().mockImplementation(async () => `CN-B947-${RUN}-${++cnSeq}`),
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
          reserveNext: jest.fn().mockImplementation(async () => `RTN-B947-${RUN}-I${++rtnSeq}`),
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
     * An order with TWO creditable invoices: X (older) bills A ($100) and B ($100); Y (latest) bills C ($100). Each product is
     * on the order too, so the return belongs to the order. Totals: X $200, Y $100.
     */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b947-${RUN}-${seq}-${label}`,
        "credit-return-line-cap-multi-invoice.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `b947 ${slug}` } });
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
      const [pA, pB, pC] = [await mk("A"), await mk("B"), await mk("C")];
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-B947-${RUN}-${seq}`,
          subtotal: 300,
          tax: 0,
          total: 300,
          status: "DELIVERED",
        } as any,
      });
      for (const p of [pA, pB, pC]) {
        await prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: p.id,
            name: p.name,
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
          } as any,
        });
      }
      const invoice = (n: number, total: number, at: string) =>
        prisma.invoice.create({
          data: {
            tenantId,
            customerId: customer.id,
            orderId: order.id,
            invoiceNumber: `INV-B947-${RUN}-${seq}-${n}`,
            status: "SENT",
            subtotal: total,
            taxAmount: 0,
            total,
            createdAt: new Date(at),
          },
        });
      const X = await invoice(1, 200, "2026-01-01T00:00:00Z");
      const Y = await invoice(2, 100, "2026-02-01T00:00:00Z");
      const line = (invoiceId: string, productId: string, d: string) =>
        prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId,
            productId,
            description: d,
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
          },
        });
      const [lineA, lineB] = [await line(X.id, pA.id, "A"), await line(X.id, pB.id, "B")];
      const lineC = await line(Y.id, pC.id, "C");
      return {
        userId: user.id,
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        X,
        Y,
        pA,
        pB,
        pC,
        lineA,
        lineB,
        lineC,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    async function receivedReturn(s: Seed, productId: string, qty = 1) {
      rtnSeq += 1;
      return prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          customerId: s.customerId,
          reason: "DAMAGED",
          status: "RECEIVED",
          returnNumber: `RTN-B947-${RUN}-${rtnSeq}`,
          items: { create: [{ tenantId: s.tenantId, productId, qty }] },
        } as any,
      });
    }
    const inTenant = <T>(s: Seed, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
    const creditItemOnX = (s: Seed, line: { id: string }, amount: number) =>
      inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.X.id,
          amount,
          items: [{ invoiceItemId: line.id, amount }],
        } as any),
      );
    const refund = (s: Seed, returnId: string) =>
      inTenant(s, () => returns.processRefund(returnId));
    const status = async (returnId: string) =>
      (await prisma.return.findUnique({ where: { id: returnId } }))!.status;
    const mintedNotes = (s: Seed) =>
      prisma.creditNote.findMany({
        where: { tenantId: s.tenantId, status: { not: "VOID" } },
        select: { amount: true, invoiceId: true, items: { select: { id: true } } },
      });

    it("1. RED REPRO: a $100 credit note item on X's line A, then a FULL return refund of A (lump sum on the latest invoice Y) is REFUSED 409 and nothing is minted", async () => {
      const s = await seed("cn-then-return");
      await creditItemOnX(s, s.lineA, 100);
      const ret = await receivedReturn(s, s.pA.id);
      await expect(refund(s, ret.id)).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
      expect(await status(ret.id)).toBe("RECEIVED"); // refused BEFORE the RECEIVED->REFUNDED claim
      expect(await mintedNotes(s)).toHaveLength(1); // only the credit note item; the refund minted nothing
    }, 60_000);

    it("2. a refund the lines CAN absorb mints exactly what it minted before: ONE lump-sum credit note (no items) on the LATEST invoice", async () => {
      const s = await seed("fits");
      await creditItemOnX(s, s.lineA, 40); // A has $60 left
      const ret = await receivedReturn(s, s.pB.id); // B is untouched
      await refund(s, ret.id);
      expect(await status(ret.id)).toBe("REFUNDED");
      const notes = await mintedNotes(s);
      const refundNote = notes.find((n) => n.invoiceId === s.Y.id);
      expect(refundNote).toBeDefined();
      expect(Number(refundNote!.amount)).toBe(100);
      expect(refundNote!.items).toHaveLength(0); // the mint is UNCHANGED: a lump sum, never itemised for 2+ invoices
    }, 60_000);

    it("3. two refunds of the SAME product in a row: the second is REFUSED (the first's lump sum on Y counts against A's line on X)", async () => {
      const s = await seed("twice");
      const r1 = await receivedReturn(s, s.pA.id);
      await refund(s, r1.id);
      const r2 = await receivedReturn(s, s.pA.id);
      await expect(refund(s, r2.id)).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
      expect(await status(r2.id)).toBe("RECEIVED");
    }, 60_000);

    it("4. boundary: $60 credited on A (of $100), a return of A is REFUSED; after the credit note is VOIDED it succeeds", async () => {
      const s = await seed("void-frees");
      const cn: any = await creditItemOnX(s, s.lineA, 60);
      const ret = await receivedReturn(s, s.pA.id);
      await expect(refund(s, ret.id)).rejects.toMatchObject({
        response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
      });
      await inTenant(s, () => creditNotes.voidWithReversal(cn.id, null as any));
      await refund(s, ret.id);
      expect(await status(ret.id)).toBe("REFUNDED");
    }, 60_000);

    it("5. a product on the order but on NO creditable invoice line is REFUSED 400 RETURN_NOTHING_BILLED (B959: it used to price $0, resolve REFUNDED and mint nothing); the return stays RECEIVED", async () => {
      const s = await seed("unplaced");
      const stray = await prisma.product.create({
        data: { tenantId: s.tenantId, name: `stray ${RUN}`, unit: "each", pricePerUnit: 10 },
      });
      const ret = await receivedReturn(s, stray.id);
      await expect(refund(s, ret.id)).rejects.toMatchObject({
        response: { code: "RETURN_NOTHING_BILLED" },
      });
      expect(await status(ret.id)).toBe("RECEIVED"); // never claimed
      expect(await mintedNotes(s)).toHaveLength(0);
    }, 60_000);

    it("7. THE OTHER DIRECTION: a return refund of A first (a lump sum on the latest invoice Y), then a credit note item on A on X is REFUSED (400 CREDIT_NOTE_OVER_HEADROOM) and nothing is minted", async () => {
      const s = await seed("refund-then-cn");
      const ret = await receivedReturn(s, s.pA.id);
      await refund(s, ret.id);
      const before = (await mintedNotes(s)).length;
      await expect(creditItemOnX(s, s.lineA, 100)).rejects.toMatchObject({
        response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
      });
      expect(await mintedNotes(s)).toHaveLength(before);
    }, 60_000);

    it("8. the headroom RE-OPENS when the refund's lump note is VOID: the credit note item on A then succeeds", async () => {
      // A refund's note backs a REFUNDED return, so voidWithReversal refuses it (CREDIT_NOTE_RETURN_BACKED: cancel the return
      // instead, and a REFUNDED return cannot be cancelled). This case tests the pool's VOID filter, so the note is set VOID
      // directly (the state an invoice-destroying or legacy void leaves).
      const s = await seed("refund-void-cn");
      const ret = await receivedReturn(s, s.pA.id);
      await refund(s, ret.id);
      const refundNote = (await prisma.creditNote.findFirst({
        where: { tenantId: s.tenantId, invoiceId: s.Y.id },
      }))!;
      await expect(creditItemOnX(s, s.lineA, 100)).rejects.toMatchObject({
        response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
      });
      await prisma.creditNote.update({ where: { id: refundNote.id }, data: { status: "VOID" } });
      await expect(creditItemOnX(s, s.lineA, 100)).resolves.toBeDefined();
    }, 60_000);

    it("9. a credit note item on a DIFFERENT product on X (B) is unaffected by a refund of A", async () => {
      const s = await seed("other-product");
      const ret = await receivedReturn(s, s.pA.id);
      await refund(s, ret.id);
      await expect(creditItemOnX(s, s.lineB, 100)).resolves.toBeDefined();
    }, 60_000);

    it("10. an invoice with NO order keeps the invoice-only check: a credit note item on it is unaffected by the pool", async () => {
      const s = await seed("no-order");
      const solo = await prisma.invoice.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          invoiceNumber: `INV-B947-${RUN}-solo`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      const soloLine = await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: solo.id,
          productId: s.pA.id,
          description: "A",
          qty: 1,
          unitPrice: 100,
          subtotal: 100,
        },
      });
      await expect(
        inTenant(s, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId: solo.id,
            amount: 100,
            items: [{ invoiceItemId: soloLine.id, amount: 100 }],
          } as any),
        ),
      ).resolves.toBeDefined();
    }, 60_000);

    async function inlineReturnOfA(s: Seed) {
      const carrying = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderNumber: `ORD-B947-${RUN}-C${++rtnSeq}`,
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
            items: [{ productId: s.pA.id, qty: 1 }],
            returnKey: `b947-${RUN}-${rtnSeq}`,
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

    it("11. THIRD DOOR reaches the POOL: A billed x2 on X only, a refund of 1 (lump on Y), a $100 credit note item on X's A line, then an INLINE return of the last piece is REFUSED by the pool's own check (the per-invoice check cannot see the lump on Y)", async () => {
      // The inline quote sources the piece to X's A line (A is billed on X only), where the PER-INVOICE check sees only the $100
      // credit note item ($100 of $200: it fits). The $100 refund lump sits on Y, invisible there. Only the ORDER POOL
      // ($100 lump + $100 item + $100 take = $300 of $200) refuses, with its OWN message ("order's invoice lines").
      const s = await seed("refund-then-inline");
      await prisma.invoiceItem.update({
        where: { id: s.lineA.id },
        data: { qty: 2, unitPrice: 100, subtotal: 200 },
      });
      await prisma.invoice.update({ where: { id: s.X.id }, data: { subtotal: 300, total: 300 } });
      const ret = await receivedReturn(s, s.pA.id, 1);
      await refund(s, ret.id); // 1 of 2 pieces: the pooled price is $100, a lump on the latest invoice Y
      expect(await status(ret.id)).toBe("REFUNDED");
      await creditItemOnX(s, s.lineA, 100); // fits: $100 + $100 of the $200 line
      const err: any = await inlineReturnOfA(s).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
      expect(err.getResponse().message).toMatch(/order's invoice lines/);
    }, 60_000);

    it("12. B960 one headroom: A billed on BOTH invoices, a $100 refund lump of A on Y, then a $100 credit note item on Y's own A line is ALLOWED ($200 of $200 across the pool); a further $100 anywhere is REFUSED", async () => {
      const s = await seed("own-line-vs-pool");
      const yA = await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.Y.id,
          productId: s.pA.id,
          description: "A",
          qty: 1,
          unitPrice: 100,
          subtotal: 100,
        },
      });
      await prisma.invoice.update({ where: { id: s.Y.id }, data: { subtotal: 200, total: 200 } });
      const ret = await receivedReturn(s, s.pA.id);
      await refund(s, ret.id); // a lump on the latest invoice Y
      expect(await status(ret.id)).toBe("REFUNDED");
      const onY = (amount: number) =>
        inTenant(s, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId: s.Y.id,
            amount,
            items: [{ invoiceItemId: yA.id, amount }],
          } as any),
        );
      // Y's own per-invoice legacy term used to attribute the lump to Y's line and refuse this; the pool has the room
      await expect(onY(100)).resolves.toBeDefined();
      // the pool is now exhausted ($100 lump + $100 item of $200 billed... plus a third $100 would be $300)
      await expect(creditItemOnX(s, s.lineA, 100)).rejects.toMatchObject({
        response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
      });
    }, 60_000);

    it("6. race: a credit note item on A and a return refund of A racing never total more than $100 on A, and neither 500s", async () => {
      const s = await seed("race");
      const ret = await receivedReturn(s, s.pA.id);
      const [a, b] = await Promise.all([
        creditItemOnX(s, s.lineA, 100).catch((e) => e),
        refund(s, ret.id).catch((e) => e),
      ]);
      for (const r of [a, b]) {
        if (r instanceof Error) expect((r as any).getStatus?.()).toBeLessThan(500);
      }
      const items = await prisma.creditNoteItem.findMany({
        where: {
          tenantId: s.tenantId,
          invoiceItemId: s.lineA.id,
          creditNote: { status: { not: "VOID" } },
        },
        select: { amount: true },
      });
      const refunded = (await status(ret.id)) === "REFUNDED" ? 100 : 0;
      expect(items.reduce((n, i) => n + Number(i.amount), 0) + refunded).toBeLessThanOrEqual(
        100.01,
      );
    }, 60_000);
  },
);
