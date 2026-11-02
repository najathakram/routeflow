/**
 * SA-1091 piece 1 (row 631) on REAL Postgres: ONE order-wide bound for every value-giver. An order's invoices were billed
 * $20.00; the order may give back at most that, whichever way (a credit note, a recorded cash refund, an inline refund, an
 * inline store credit). The lump credit note (no lines) is the door the line checks cannot see: $20 invoice paid cash, a $20
 * lump note, then $20 cash back is $40 out for $20.
 *
 * Every case is a throwaway `qa-rr631-<run>-<n>` tenant (approved by `assertTestTenant`) with ONE sale: a DELIVERED order of
 * 4 pieces at $5.00 = $20.00, its PAID invoice (a CASH payment of $20.00) and the real services, wired like
 * inline-returns-refund.db.spec.ts. Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 *
 *   RR-1  lump note $20, then a recorded (standard) cash refund of the 4 pieces: 409 RETURN_REFUND_OVER_LINE_HEADROOM
 *   RR-2  lump note $20, then an inline REFUND capture: 409
 *   RR-3  lump note $20, then an inline store-credit capture: 409
 *   RR-4  recorded cash refund of $20, then a lump note $20: 400 CREDIT_NOTE_OVER_HEADROOM
 *   RR-5  inline store credit of $20, then a lump note $20: 400 CREDIT_NOTE_OVER_HEADROOM
 *   RR-6  lump note $5 on $20: a refund of 3 pieces ($15) passes, the 4th piece ($5 more) is refused
 *   RR-7  the lump note voided: the room comes back
 *   RR-8  a goodwill note with no invoice counts nothing
 *   RR-9  a refund's own note, and an inline return's standalone note, are each counted ONCE
 *   RR-10 two invoices on one order: the bound is order-wide
 *   RR-11 a recorded refund and a lump note race for the last of the room: exactly one passes (RR-11a: the refund queues
 *         first, RR-11b: the note)
 *   LK-2  a never-invoiced order's refund is linked to its note, so a typed credit after invoicing is counted
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
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
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { waitUntilBlocked } from "../common/testing/blocked-wait";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const PRICE = 5;
const PIECES = 4;

type Seed = {
  tenantId: string;
  userId: string;
  customerId: string;
  productId: string;
  orderId: string;
  invoiceId: string;
};

describeDb("SA-1091 piece 1: one order-wide bound for every value-giver — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  let returns: ReturnsService;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;
  let keySeq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const numbering = {
      reserveNext: jest.fn().mockImplementation(async () => `N-RR631-${RUN}-${++numSeq}`),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        ReturnsService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    creditNotes = mod.get(CreditNotesService);
    returns = mod.get(ReturnsService);
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
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
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

  /** One DELIVERED sale of 4 pieces at $5.00 = $20.00 and its PAID invoice (a CASH payment of $20.00). */
  async function seed(label: string): Promise<Seed> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-rr631-${RUN}-${seq}-${label}`,
      "order-refund-bound-sa1091.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `rr631 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `rr631 ${label}`,
        contactName: `rr631 ${label}`,
        tenantId,
      } as any,
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${slug}`,
        unit: "each",
        pricePerUnit: PRICE,
        currentStock: 0,
      } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-RR631-${RUN}-${seq}`,
        subtotal: PRICE * PIECES,
        tax: 0,
        total: PRICE * PIECES,
        status: "DELIVERED",
      } as any,
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        name: product.name,
        qty: PIECES,
        unitPrice: PRICE,
        subtotal: PRICE * PIECES,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-RR631-${RUN}-${seq}`,
        status: "PAID",
        subtotal: PRICE * PIECES,
        taxAmount: 0,
        total: PRICE * PIECES,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        orderItemId: orderItem.id,
        productId: product.id,
        description: "Widget",
        qty: PIECES,
        unitPrice: PRICE,
        subtotal: PRICE * PIECES,
      } as any,
    });
    await prisma.invoicePayment.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        amount: PRICE * PIECES,
        method: "CASH",
        status: "PAID",
      } as any,
    });
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      productId: product.id,
      orderId: order.id,
      invoiceId: invoice.id,
    };
  }

  const staff = (s: Seed) => ({
    sub: s.userId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: s.tenantId,
    tenantSlug: "x",
  });
  const inTenant = (s: Seed, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(s.tenantId, fn) as Promise<any>;
  const status = (e: any) => e?.status ?? e?.getStatus?.();
  const codeOf = (e: any) => e?.getResponse?.()?.code;
  const settle = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

  /** A lump staff credit note (no line items) on the invoice: what the create screen's "empty selection" posts. */
  const lump = (s: Seed, amount: number, invoiceId: string | null = s.invoiceId) =>
    settle(
      inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: invoiceId ?? undefined,
          amount,
        } as any),
      ),
    );

  /** A STANDARD return of `pieces`, RECEIVED, then refunded in `method` (a recorded cash refund by default). */
  async function standardReturn(s: Seed, pieces = PIECES) {
    const ret = (await inTenant(s, () =>
      returns.create(
        {
          orderId: s.orderId,
          reason: "DAMAGED",
          items: [{ productId: s.productId, qty: pieces }],
        } as any,
        s.userId,
      ),
    )) as { id: string };
    await prisma.return.update({ where: { id: ret.id }, data: { status: "RECEIVED" } });
    return ret.id;
  }
  const refundRecorded = async (s: Seed, pieces = PIECES, existing?: string) => {
    const id = existing ?? (await standardReturn(s, pieces));
    return {
      id,
      ...(await settle(
        inTenant(s, () =>
          returns.processRefund(id, { method: "EXTERNAL_REFUND" } as any, staff(s)),
        ),
      )),
    };
  };
  const refundAsCredit = async (s: Seed, pieces = PIECES) => {
    const id = await standardReturn(s, pieces);
    return {
      id,
      ...(await settle(
        inTenant(s, () => returns.processRefund(id, { method: "CREDIT_NOTE" } as any, staff(s))),
      )),
    };
  };
  const inlineCapture = (s: Seed, pieces: number, resolution: "STORE_CREDIT" | "REFUND") =>
    settle(
      inTenant(s, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: s.orderId,
            items: [{ productId: s.productId, qty: pieces, boxes: 0, pieces }],
            returnKey: `rr631-${RUN}-${++keySeq}`,
            resolution,
          },
          staff(s),
        ),
      ),
    );

  const liveNotes = (s: Seed) =>
    prisma.creditNote.count({ where: { tenantId: s.tenantId, status: { not: "VOID" } } });
  const returnRows = (s: Seed) => prisma.return.count({ where: { tenantId: s.tenantId } });
  const refusedReturn = (r: { ok: boolean; error?: any }) => {
    expect(r.ok).toBe(false);
    expect(status(r.error)).toBe(409);
    expect(codeOf(r.error)).toBe(API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM);
    // SA-1091 A-1: every order-bound refusal carries the marker and the room left, for the web copy
    expect(r.error.getResponse()).toMatchObject({
      orderBound: true,
      remaining: expect.any(Number),
    });
  };
  const refusedNote = (r: { ok: boolean; error?: any }) => {
    expect(r.ok).toBe(false);
    expect(status(r.error)).toBe(400);
    expect(codeOf(r.error)).toBe(API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM);
    // The invoice-total cap runs before the order bound and is its own refusal (no room figure); the order-wide one carries both.
    const body = r.error.getResponse();
    if (body.orderBound === undefined) expect(body.message).toMatch(/would exceed invoice total/);
    else expect(body).toMatchObject({ orderBound: true, remaining: expect.any(Number) });
  };

  it("RR-1: a $20 lump note, then a recorded cash refund of the whole sale — 409, nothing recorded", async () => {
    const s = await seed("rr1");
    expect((await lump(s, 20)).ok).toBe(true);
    const out = await refundRecorded(s);
    refusedReturn(out);
    const row = await prisma.return.findUniqueOrThrow({ where: { id: out.id } });
    expect(row.status).toBe("RECEIVED");
    expect(row.refundAmount).toBeNull();
  }, 60_000);

  it("RR-2: a $20 lump note, then an inline REFUND capture — 409, no return, no stock", async () => {
    const s = await seed("rr2");
    expect((await lump(s, 20)).ok).toBe(true);
    const out = await inlineCapture(s, PIECES, "REFUND");
    refusedReturn(out as any);
    expect(await returnRows(s)).toBe(0);
    expect(
      Number((await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).currentStock),
    ).toBe(0);
  }, 60_000);

  it("RR-3: a $20 lump note, then an inline store-credit capture — 409, no credit minted", async () => {
    const s = await seed("rr3");
    expect((await lump(s, 20)).ok).toBe(true);
    const out = await inlineCapture(s, PIECES, "STORE_CREDIT");
    refusedReturn(out as any);
    expect(await liveNotes(s)).toBe(1); // only the lump note
    expect(await returnRows(s)).toBe(0);
  }, 60_000);

  it("RR-4: a recorded cash refund of $20, then a $20 lump note — 400, no note", async () => {
    const s = await seed("rr4");
    const first = await refundRecorded(s);
    expect(first.ok).toBe(true);
    refusedNote(await lump(s, 20));
    expect(await liveNotes(s)).toBe(0);
  }, 60_000);

  it("RR-5: an inline store credit of $20, then a $20 lump note — 400, one note only", async () => {
    const s = await seed("rr5");
    expect((await inlineCapture(s, PIECES, "STORE_CREDIT")).ok).toBe(true);
    refusedNote(await lump(s, 20));
    expect(await liveNotes(s)).toBe(1); // the inline return's own note
  }, 60_000);

  it("RR-6: a $5 lump note — a refund of 3 pieces ($15) passes, the 4th piece is refused", async () => {
    const s = await seed("rr6");
    expect((await lump(s, 5)).ok).toBe(true);
    const fits = await refundRecorded(s, 3);
    expect(fits.ok ? "ok" : String(fits.error?.message)).toBe("ok");
    refusedReturn(await refundRecorded(s, 1)); // $5 more would be $25 given back on $20
  }, 90_000);

  it("RR-7: voiding the lump note gives the room back", async () => {
    const s = await seed("rr7");
    const made = await lump(s, 20);
    expect(made.ok).toBe(true);
    const refused = await refundRecorded(s);
    refusedReturn(refused);
    const noteId = (made as { value: { id: string } }).value.id;
    await inTenant(s, () => creditNotes.voidWithReversal(noteId, s.userId, "rr7"));
    // the SAME return, retried: the refusal left it RECEIVED, and the voided note gave the room back
    const again = await refundRecorded(s, PIECES, refused.id);
    expect(again.ok ? "ok" : String(again.error?.message)).toBe("ok");
  }, 90_000);

  it("RR-8: a goodwill note with no invoice counts nothing", async () => {
    const s = await seed("rr8");
    const goodwill = await lump(s, 20, null);
    expect(goodwill.ok ? "ok" : String(goodwill.error?.message)).toBe("ok");
    const out = await refundRecorded(s);
    expect(out.ok ? "ok" : String(out.error?.message)).toBe("ok");
  }, 60_000);

  it("RR-9: a refund's own note and an inline return's standalone note are each counted once", async () => {
    const s = await seed("rr9");
    expect((await refundAsCredit(s, 2)).ok).toBe(true); // $10 of store credit, its note counted once
    expect((await lump(s, 10)).ok).toBe(true); // $10 of room is left: not $5 (a double count)
    refusedNote(await lump(s, 0.01));
    const t = await seed("rr9b");
    expect((await inlineCapture(t, 2, "STORE_CREDIT")).ok).toBe(true);
    expect((await lump(t, 10)).ok).toBe(true);
    refusedNote(await lump(t, 0.01));
  }, 120_000);

  it("RR-10: two invoices on one order — a note on one counts against a refund of the order", async () => {
    const s = await seed("rr10");
    // split the sale: the first invoice is trimmed to $10 and a second SENT/PAID invoice carries the other $10
    await prisma.invoice.update({ where: { id: s.invoiceId }, data: { total: 10, subtotal: 10 } });
    const second = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        orderId: s.orderId,
        invoiceNumber: `INV-RR631-${RUN}-${seq}-b`,
        status: "PAID",
        subtotal: 10,
        taxAmount: 0,
        total: 10,
      },
    });
    await prisma.invoicePayment.create({
      data: {
        tenantId: s.tenantId,
        invoiceId: second.id,
        amount: 10,
        method: "CASH",
        status: "PAID",
      } as any,
    });
    expect((await lump(s, 10)).ok).toBe(true); // all of the first invoice
    // the order was billed $20 and $10 is gone: a cash refund of 2 pieces ($10) fits, 2 more ($10) are refused
    const fits = await refundRecorded(s, 2);
    expect(fits.ok ? "ok" : String(fits.error?.message)).toBe("ok");
    refusedReturn(await refundRecorded(s, 2));
  }, 90_000);

  it("LK-2 (piece 2): a never-invoiced order's store-credit refund is linked to its note, so once the order is invoiced a typed credit on the line is counted", async () => {
    const s = await seed("lk2");
    // the sale as it stood before it was invoiced: no invoice rows at all
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: s.invoiceId } });
    const oldLines = await prisma.invoiceItem.findMany({ where: { invoiceId: s.invoiceId } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: s.invoiceId } });
    await prisma.invoice.delete({ where: { id: s.invoiceId } });
    const refund = await refundAsCredit(s, PIECES);
    expect(refund.ok ? "ok" : String(refund.error?.message)).toBe("ok");
    const ret = await prisma.return.findUniqueOrThrow({ where: { id: refund.id } });
    const note = await prisma.creditNote.findFirstOrThrow({ where: { tenantId: s.tenantId } });
    expect(note.invoiceId).toBeNull(); // hangs on no invoice: the link is the ONLY way it is counted
    expect(ret.creditNoteId).toBe(note.id);
    // now the order is invoiced: a typed credit on the line, on top of the refund, is refused
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        orderId: s.orderId,
        invoiceNumber: `INV-RR631-${RUN}-${seq}-late`,
        status: "SENT",
        subtotal: PRICE * PIECES,
        taxAmount: 0,
        total: PRICE * PIECES,
      },
    });
    const line = await prisma.invoiceItem.create({
      data: {
        tenantId: s.tenantId,
        invoiceId: invoice.id,
        orderItemId: oldLines[0].orderItemId,
        productId: s.productId,
        description: "Widget",
        qty: PIECES,
        unitPrice: PRICE,
        subtotal: PRICE * PIECES,
      } as any,
    });
    const typed = await settle(
      inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: invoice.id,
          amount: 20,
          items: [{ invoiceItemId: line.id, amount: 20 }],
        } as any),
      ),
    );
    refusedNote(typed);
  }, 90_000);

  /**
   * RR-11: the last of the room is wanted by a recorded refund and by a lump note at once. A raw connection holds the invoice
   * row; the FIRST writer is started and seen queued behind it, then the SECOND, so the queue order (and so who wakes first) is
   * fixed, not luck. Whoever wakes first commits; the other must then see it. The note's Serializable transaction took its
   * snapshot before it waited, and a recorded refund writes only Return rows: only a new Invoice row version (the claim's write)
   * makes the note re-read, so "claim first" is the order that goes red without it.
   */
  async function raceForLastRoom(label: string, first: "refund" | "note") {
    const s = await seed(label);
    const url = requireLocalDatabaseUrl();
    const holder = new Client({ connectionString: url });
    const poller = new Client({ connectionString: url });
    await holder.connect();
    await poller.connect();
    const id = await standardReturn(s, PIECES);
    const startRefund = () =>
      inTenant(s, () => returns.processRefund(id, { method: "EXTERNAL_REFUND" } as any, staff(s)));
    const startNote = () =>
      inTenant(s, () =>
        creditNotes.create({ customerId: s.customerId, invoiceId: s.invoiceId, amount: 20 } as any),
      );
    const calls: Array<Promise<any>> = [];
    try {
      await holder.query("BEGIN");
      // the one lock both writers take on a single-invoice order: the note locks only the Invoice, the claim ends on it
      await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoiceId]);
      const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      for (const [n, start] of (first === "refund"
        ? [startRefund, startNote]
        : [startNote, startRefund]
      ).entries()) {
        calls.push(start());
        const queued = await waitUntilBlocked(poller, {
          holderPid,
          transitive: true,
          atLeast: n + 1,
          timeoutMs: 15_000,
          intervalMs: 50,
        });
        expect(queued.length).toBeGreaterThanOrEqual(n + 1);
      }
      await holder.query("ROLLBACK");
      const results = await Promise.allSettled(calls);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const row = await prisma.return.findUniqueOrThrow({ where: { id } });
      // never both: a recorded $20 AND a $20 note
      expect((row.refundedAt ? 1 : 0) + (await liveNotes(s))).toBe(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(calls);
      await holder.end().catch(() => undefined);
      await poller.end().catch(() => undefined);
    }
  }

  it("RR-11a: the recorded refund queues first — exactly one passes", async () => {
    await raceForLastRoom("rr11a", "refund");
  }, 90_000);

  it("RR-11b: the lump note queues first — exactly one passes", async () => {
    await raceForLastRoom("rr11b", "note");
  }, 90_000);
});
