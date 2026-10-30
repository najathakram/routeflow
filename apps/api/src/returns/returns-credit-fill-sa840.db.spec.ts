/**
 * SA-840 A-2 on REAL Postgres: F2 (the refund pricer and the order pool fill an order's invoices in ONE order) and F1 (a refund is
 * priced on what the lines already carry), on review-b's MULTI fixture with EXPLICIT invoice ids and createdAt, so the id order is
 * chosen, not drawn. ONE file on purpose: the fixture writes rows (invoices, items, payments, deletes), and the repo's writer
 * censuses scan every non-spec file under src; a harness outside a `*.spec.ts` would need a hand-added pin in each of them.
 *
 * Product P (unit price 2.50 a piece, pack 10), ONE order, two PAID invoices:
 *   line A = 400 pcs, 90.00 net, 10% tax (9.00)     on invoice A, total  99.00
 *   line B = 100 pcs, 25.00 net,  8% tax (2.00)     on invoice B, total  27.00
 * `older` names the invoice with the earlier `createdAt` (the pricer's fill order puts its line first); `smallerId` names the
 * invoice whose id sorts first. A one-shot pooled 150 pcs on the pricer's fill (B, then A) is 25.00 + 11.25 net, 2.00 + 1.125 tax: 39.38.
 * Every tenant is a throwaway `qa-sa840-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order by `cleanup`.
 * Each case logs its OBSERVED figures (`SA840 OBSERVED {...}`). Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

export type Side = "A" | "B";
export type RefundResult =
  | { amount: number }
  | { refused: { status: number | undefined; code: string | undefined; message: string } };
export interface MultiOpts {
  /** the invoice created EARLIER (its line is first in the pricer's fill order) */
  older: Side;
  /** the invoice whose id sorts first (the order the pool replayed in before A-2) */
  smallerId: Side;
}
/** The one-shot figure for 150 pcs on the fill B (100 pcs) then A (50 pcs): the bound review-b measured. */
const ONE_SHOT_150 = 39.38;

async function buildHarness(tag: string) {
  const run = randomUUID().slice(0, 8);
  requireLocalDatabaseUrl();
  const tenantCtx = new TenantContextService();
  const prisma = new PrismaService(tenantCtx);
  await prisma.$connect();
  const anyMethod = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
  );
  let cnSeq = 0;
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
      {
        provide: NumberingService,
        useValue: {
          reserveNext: jest.fn().mockImplementation(async () => `CN-840-${run}-${++cnSeq}`),
        },
      },
    ],
  }).compile();
  const returns = mod.get(ReturnsService);
  const tenantIds: string[] = [];
  let seq = 0;

  async function cleanup() {
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
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma.$disconnect();
  }

  /** `invoices: 2` is the MULTI order; `invoices: 1` is SINGLE (both lines on ONE invoice, 10% on each, as the R-C fixture). */
  async function seed(
    label: string,
    opts: MultiOpts & { invoices?: 1 | 2 } = { older: "B", smallerId: "B" },
  ) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa840-${run}-${seq}-${tag}-${label}`,
      "sa840-multi-fixture.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa840 ${slug}` } });
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
        pricePerUnit: 2.5,
        unitsPerBox: 10,
      } as any,
    });
    const single = opts.invoices === 1;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-840-${run}-${seq}`,
        subtotal: 115,
        tax: single ? 11.5 : 11,
        total: single ? 126.5 : 126,
        status: "DELIVERED",
      } as any,
    });
    const mkLine = (position: number, over: Record<string, unknown>) =>
      prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          position,
          ...over,
        } as any,
      });
    const lineA = await mkLine(0, {
      qty: 400,
      unitPrice: 45,
      subtotal: 90,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 200,
      unitLabel: "Case",
    });
    const lineB = await mkLine(1, {
      qty: 100,
      unitPrice: 2.5,
      subtotal: 25,
      boxes: 10,
      pieces: 0,
      unitsPerBox: 10,
    });
    // explicit ids: `...01` sorts before `...02`; explicit createdAt: the older invoice is an hour earlier
    const idOf = (side: Side) =>
      `${run}-0000-4000-8000-${String(seq).padStart(9, "0")}${side === opts.smallerId ? "01" : "02"}`;
    const createdAtOf = (side: Side) =>
      new Date(Date.now() - (side === opts.older ? 7_200_000 : 3_600_000));
    const mkInvoice = async (side: Side | "ONE", subtotal: number, tax: number) => {
      const key: Side = side === "ONE" ? "B" : side;
      const invoice = await prisma.invoice.create({
        data: {
          id: idOf(key),
          createdAt: createdAtOf(key),
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-840-${run}-${seq}-${key}`,
          status: "PAID",
          subtotal,
          taxAmount: tax,
          discount: 0,
          total: subtotal + tax,
        },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: subtotal + tax,
          method: "CASH",
          status: "PAID",
        },
      });
      return invoice;
    };
    const mkItem = (invoiceId: string, orderItemId: string, over: Record<string, unknown>) =>
      prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId,
          orderItemId,
          productId: product.id,
          description: "P",
          ...over,
        } as any,
      });
    const shapeA = { qty: 400, unitPrice: 45, subtotal: 90, boxes: 2, pieces: 0, unitsPerBox: 200 };
    const shapeB = {
      qty: 100,
      unitPrice: 2.5,
      subtotal: 25,
      boxes: 10,
      pieces: 0,
      unitsPerBox: 10,
    };
    let invA;
    let invB;
    let iA;
    let iB;
    if (single) {
      invA = invB = await mkInvoice("ONE", 115, 11.5);
      iA = await mkItem(invA.id, lineA.id, { ...shapeA, taxRate: 0.1 });
      iB = await mkItem(invA.id, lineB.id, { ...shapeB, taxRate: 0.1 });
    } else {
      invA = await mkInvoice("A", 90, 9);
      invB = await mkInvoice("B", 25, 2);
      iA = await mkItem(invA.id, lineA.id, { ...shapeA, taxRate: 0.1 });
      iB = await mkItem(invB.id, lineB.id, { ...shapeB, taxRate: 0.08 });
    }
    return {
      tenantId,
      userId: user.id,
      orderId: order.id,
      productId: product.id,
      lineA,
      lineB,
      iA,
      iB,
      invA,
      invB,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const actor = (s: Seed) => ({ sub: s.userId, role: "OPERATOR" }) as any;
  const create = (s: Seed, items: Array<Record<string, unknown>>) =>
    tenantCtx.run(s.tenantId, () =>
      returns.create({ orderId: s.orderId, reason: "DAMAGED", items } as any, s.userId),
    ) as Promise<{ id: string }>;
  /** A pooled return of `qty` pieces (no line named), or a line-named one. */
  const pooled = (s: Seed, qty: number) => create(s, [{ productId: s.productId, qty }]);
  const onLine = (s: Seed, side: Side, qty: number) =>
    create(s, [
      { productId: s.productId, orderItemId: (side === "A" ? s.lineA : s.lineB).id, qty },
    ]);

  /** RECEIVED, then processRefund. Resolves { amount } on success or { refused } with the error's code / message. */
  async function refund(
    s: Seed,
    returnId: string,
    method: "CREDIT_NOTE" | "EXTERNAL_REFUND" = "CREDIT_NOTE",
  ): Promise<RefundResult> {
    await prisma.return.update({ where: { id: returnId }, data: { status: "RECEIVED" } });
    try {
      await tenantCtx.run(s.tenantId, () =>
        returns.processRefund(returnId, { method } as any, actor(s)),
      );
    } catch (err: any) {
      const body = typeof err?.getResponse === "function" ? err.getResponse() : undefined;
      return {
        refused: {
          status: err?.getStatus?.() as number | undefined,
          code: body?.code as string | undefined,
          message: String(err?.message ?? err),
        },
      };
    }
    const row = await prisma.return.findUniqueOrThrow({ where: { id: returnId } });
    return { amount: Number(row.refundAmount) };
  }
  const returnRow = (id: string) => prisma.return.findUniqueOrThrow({ where: { id } });
  const creditNoteCount = (s: Seed) =>
    prisma.creditNote.count({ where: { tenantId: s.tenantId, status: { not: "VOID" } } });
  const estimateOf = (s: Seed, returnId: string) =>
    tenantCtx.run(s.tenantId, () => returns.findOne(returnId)) as Promise<{
      refundEstimate: number;
    }>;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    prisma,
    tenantCtx,
    returns,
    seed,
    pooled,
    onLine,
    refund,
    returnRow,
    creditNoteCount,
    estimateOf,
    round2,
    cleanup,
  };
}
type Harness = Awaited<ReturnType<typeof buildHarness>>;

// ───────────────────────────── F2: one fill order ─────────────────────────────
/*
 * SA-840 A-2 (F2) on REAL Postgres: the refund pricer and the order pool fill an order's invoices in ONE order (createdAt, then
 * id), so the line a pooled lump was PRICED on is the line the pool CREDITS it to. Fixture: review-b's MULTI order
 * (`sa840-multi-fixture.ts`), with EXPLICIT invoice ids and createdAt so the id order is chosen, not drawn.
 *
 *   R-F2   A's invoice is the NEWER one and has the SMALLER id. A pooled 100 pcs is refunded (priced on B, the older invoice's
 *          line), then a "line B 50" return is received and refunded. Before A-2 the pool replayed the lump onto A (id order), so
 *          B 50 passed the refusal and was paid: 150 pcs refunded for more than the 39.38 the lines are worth. After: 409
 *          RETURN_REFUND_OVER_LINE_HEADROOM, no second credit note, the return stays RECEIVED.
 *   G-F2b  the id order matches createdAt (B older, B has the smaller id): refused before and after.
 *   G-F2c  B on the NEWER invoice (A older, smaller id): "B 50" is refused 400 by the latest invoice's room (2.25 left of B's 27.00
 *          after the pooled lump landed there), before and after A-2 (SA-840 A-3 keeps the refusal). See the case's comment.
 *
 * Each case logs its OBSERVED figures (`SA840 OBSERVED {...}`) so a run at the pre-fix base reports today's values.
 * Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 */
describeDb(
  "SA-840 A-2 (F2): one fill order for the refund pricer and the order pool — real Postgres",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildHarness("f2");
    }, 120_000);
    afterAll(async () => {
      await h?.cleanup();
    });

    const OVER_HEADROOM = "RETURN_REFUND_OVER_LINE_HEADROOM";

    /** pooled 100, then "line B 50"; returns what each refund did. */
    async function pooledThenLineB(label: string, older: "A" | "B", smallerId: "A" | "B") {
      const s = await h.seed(label, { older, smallerId });
      const first = await h.refund(s, (await h.pooled(s, 100)).id);
      const second = await h.onLine(s, "B", 50);
      const out = await h.refund(s, second.id);
      const row = await h.returnRow(second.id);
      const observed = {
        case: label,
        pooled100: "amount" in first ? first.amount : first.refused,
        lineB50: "amount" in out ? out.amount : out.refused,
        sum: "amount" in first && "amount" in out ? h.round2(first.amount + out.amount) : null,
        bound150: ONE_SHOT_150,
        returnStatus: row.status,
        creditNotes: await h.creditNoteCount(s),
      };
      console.info(`SA840 OBSERVED ${JSON.stringify(observed)}`);
      return { first, out, row, s };
    }

    it("R-F2: A's NEWER invoice has the SMALLER id — a pooled 100 then 'line B 50' is refused 409, no second credit note, the return stays RECEIVED", async () => {
      const { first, out, row, s } = await pooledThenLineB("rf2", "B", "A");
      expect(first).toMatchObject({ amount: expect.any(Number) });
      expect(out).toMatchObject({ refused: { status: 409, code: OVER_HEADROOM } });
      expect(row.status).toBe("RECEIVED");
      expect(row.creditNoteId).toBeNull();
      expect(await h.creditNoteCount(s)).toBe(1); // the pooled 100's note only
    });

    it("G-F2b: the id order matches createdAt (B older with the smaller id) — refused before and after", async () => {
      const { out, row } = await pooledThenLineB("gf2b", "B", "B");
      expect(out).toMatchObject({ refused: { status: 409, code: OVER_HEADROOM } });
      expect(row.status).toBe("RECEIVED");
    });

    // GUARD (SA-840 A-3: the refusal is KEPT). With B on the NEWER invoice the pooled 100 (24.75, priced on A, the older invoice's
    // line) is minted as ONE lump on the LATEST invoice, B's (27.00), leaving 2.25 of room there, so "B 50" (13.50) is refused 400 by
    // the latest-invoice room check, before and after A-2. The 400 (invoice room) versus the 409 (line headroom, R-F2) is what tells
    // the two gates apart. Which invoice a lump is minted on is an owner question, out of #3800.
    it("G-F2c (guard): B on the NEWER invoice — 'B 50' is refused 400 naming the LATEST invoice's remaining room 2.25, before and after; one credit note, the return stays RECEIVED", async () => {
      const { first, out, row, s } = await pooledThenLineB("gf2c", "A", "A");
      expect(first).toMatchObject({ amount: 24.75 });
      expect(out).toMatchObject({
        refused: { status: 400, message: expect.stringMatching(/remaining room 2\.25/) },
      });
      expect(out).not.toMatchObject({ refused: { code: OVER_HEADROOM } }); // the invoice-room 400, not the line-headroom 409
      expect(row.status).toBe("RECEIVED");
      expect(row.creditNoteId).toBeNull();
      expect(await h.creditNoteCount(s)).toBe(1);
    });
  },
);

// ───────────────────────── F1: priced on the credits carried ─────────────────────────
/*
 * SA-840 A-2 (F1) on REAL Postgres: the refund is priced on what the lines ALREADY carry, so two refunds that together cover a
 * quantity pay what one refund of that quantity would, to the cent (the slice telescopes per invoice pool, SA-840 section 2).
 * Fixture: review-b's MULTI order (`sa840-multi-fixture.ts`): line B 100 pcs on the OLDER invoice (8% tax), line A 400 pcs on the
 * NEWER one (10% tax). A one-shot pooled 150 pcs fills B (27.00) then A (50 pcs: 11.25 + 1.13) = 39.38.
 *
 *   R-F1   a pooled 50, then a pooled 100: the two lumps sum to the one-shot pooled 150. Before: the second lump was priced on an
 *          uncredited B (27.00), 40.50 in all.
 *   R-F1b  "line B 50", then a pooled 100: the same one-shot equality.
 *   R-F1c  both pairs as EXTERNAL_REFUND: the recorded amounts sum to the one-shot.
 *   G-F1d  ONE invoice: the mint stays itemised (credit note items on the invoice's lines), and the detail estimate equals the mint
 *          when an earlier credit note exists.
 *   G-F1f  a RESOLVED return (MULTI credit note, MULTI external refund, SINGLE credit note): findOne's estimate equals refundAmount.
 *   G-F1e  REG-B53's latest-invoice room still refuses a MULTI pooled 500 (the latest invoice has 99.00 of room).
 *
 * Each case logs its OBSERVED figures (`SA840 OBSERVED {...}`) so a run at the pre-fix base reports today's values.
 * Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 */
describeDb(
  "SA-840 A-2 (F1): a refund is priced on what the lines already carry — real Postgres",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildHarness("f1");
    }, 120_000);
    afterAll(async () => {
      await h?.cleanup();
    });

    const amountOf = (r: Awaited<ReturnType<Harness["refund"]>>): number => {
      if (!("amount" in r)) throw new Error(`refused: ${JSON.stringify(r.refused)}`);
      return r.amount;
    };
    const log = (o: Record<string, unknown>) => console.info(`SA840 OBSERVED ${JSON.stringify(o)}`);

    /** One-shot pooled 150 on a fresh identical order, by `method`. */
    async function oneShot(label: string, method: "CREDIT_NOTE" | "EXTERNAL_REFUND") {
      const s = await h.seed(`${label}-one`, { older: "B", smallerId: "B" });
      return amountOf(await h.refund(s, (await h.pooled(s, 150)).id, method));
    }

    it("R-F1: a pooled 50 then a pooled 100 sum to the one-shot pooled 150 (observed: the second lump was priced uncredited)", async () => {
      const s = await h.seed("rf1", { older: "B", smallerId: "B" });
      const r1 = await h.pooled(s, 50);
      const first = amountOf(await h.refund(s, r1.id));
      const r2 = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, r2.id)).refundEstimate; // the detail figure for the second lump, before it is paid
      const second = amountOf(await h.refund(s, r2.id));
      const one = await oneShot("rf1", "CREDIT_NOTE");
      log({
        case: "R-F1",
        first,
        second,
        sum: h.round2(first + second),
        oneShot150: one,
        bound: ONE_SHOT_150,
        findOneEstimateOfSecond: estimate,
      });
      expect(h.round2(first + second)).toBe(one);
      expect(estimate).toBe(second); // detail = mint
    });

    it("R-F1b: 'line B 50' then a pooled 100 sum to the one-shot pooled 150", async () => {
      const s = await h.seed("rf1b", { older: "B", smallerId: "B" });
      const first = amountOf(await h.refund(s, (await h.onLine(s, "B", 50)).id));
      const second = amountOf(await h.refund(s, (await h.pooled(s, 100)).id));
      const one = await oneShot("rf1b", "CREDIT_NOTE");
      log({ case: "R-F1b", first, second, sum: h.round2(first + second), oneShot150: one });
      expect(h.round2(first + second)).toBe(one);
    });

    it("R-F1c: both pairs as EXTERNAL_REFUND — the recorded amounts sum to the one-shot", async () => {
      const one = await oneShot("rf1c", "EXTERNAL_REFUND");
      const a = await h.seed("rf1c-a", { older: "B", smallerId: "B" });
      const a1 = amountOf(await h.refund(a, (await h.pooled(a, 50)).id, "EXTERNAL_REFUND"));
      const a2 = amountOf(await h.refund(a, (await h.pooled(a, 100)).id, "EXTERNAL_REFUND"));
      const b = await h.seed("rf1c-b", { older: "B", smallerId: "B" });
      const b1 = amountOf(await h.refund(b, (await h.onLine(b, "B", 50)).id, "EXTERNAL_REFUND"));
      const b2 = amountOf(await h.refund(b, (await h.pooled(b, 100)).id, "EXTERNAL_REFUND"));
      log({
        case: "R-F1c",
        oneShot150: one,
        pooledThenPooled: [a1, a2, h.round2(a1 + a2)],
        lineThenPooled: [b1, b2, h.round2(b1 + b2)],
      });
      expect(h.round2(a1 + a2)).toBe(one);
      expect(h.round2(b1 + b2)).toBe(one);
    });

    it("G-F1d: ONE invoice — the mint stays itemised, and the detail estimate equals the mint once an earlier credit exists", async () => {
      const s = await h.seed("gf1d", { older: "B", smallerId: "B", invoices: 1 });
      const earlier = await h.refund(s, (await h.pooled(s, 100)).id);
      const next = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, next.id)).refundEstimate;
      const minted = amountOf(await h.refund(s, next.id));
      const itemCount = await h.prisma.creditNoteItem.count({ where: { tenantId: s.tenantId } });
      log({
        case: "G-F1d",
        earlier: amountOf(earlier),
        findOneEstimate: estimate,
        minted,
        creditNoteItems: itemCount,
      });
      expect(itemCount).toBeGreaterThan(0); // itemised against the invoice's lines
      expect(estimate).toBe(minted);
    });

    it("G-F1d2: ONE invoice with an OPERATOR credit already on line A — the detail estimate equals the mint", async () => {
      const s = await h.seed("gf1d2", { older: "B", smallerId: "B", invoices: 1 });
      const note = await h.prisma.creditNote.create({
        data: {
          tenantId: s.tenantId,
          customerId: (await h.prisma.order.findUniqueOrThrow({ where: { id: s.orderId } }))
            .customerId,
          invoiceId: s.invA.id,
          creditNoteNumber: `CN-840-OP-${s.invA.id.slice(0, 8)}`,
          amount: 50,
          status: "ISSUED",
        },
      });
      await h.prisma.creditNoteItem.create({
        data: {
          tenantId: s.tenantId,
          creditNoteId: note.id,
          invoiceItemId: s.iA.id,
          amount: 50,
          qty: 200,
        },
      });
      const next = await h.pooled(s, 100);
      const estimate = (await h.estimateOf(s, next.id)).refundEstimate;
      const minted = amountOf(await h.refund(s, next.id));
      log({ case: "G-F1d2", findOneEstimate: estimate, minted });
      expect(estimate).toBe(minted);
    });

    // A RESOLVED return's detail estimate is priced against every OTHER credit (`own` leaves its own refund out), so it equals the
    // recorded refundAmount to the cent. A guard at the base (the read priced uncredited then); load-bearing against dropping `own`:
    // the return's own lump would then count as already carried and the estimate would price the NEXT slice of the lines.
    it.each([
      ["MULTI CREDIT_NOTE", 2, "CREDIT_NOTE"],
      ["MULTI EXTERNAL_REFUND", 2, "EXTERNAL_REFUND"],
      ["SINGLE CREDIT_NOTE", 1, "CREDIT_NOTE"],
    ] as const)(
      "G-F1f: %s — findOne's estimate for the resolved return equals its refundAmount",
      async (label, invoices, method) => {
        const s = await h.seed(`gf1f-${label.replace(/\W+/g, "-").toLowerCase()}`, {
          older: "B",
          smallerId: "B",
          invoices,
        });
        const ret = await h.pooled(s, 100);
        const minted = amountOf(await h.refund(s, ret.id, method));
        const row = await h.returnRow(ret.id);
        const estimate = (await h.estimateOf(s, ret.id)).refundEstimate;
        log({
          case: "G-F1f",
          label,
          minted,
          refundAmount: Number(row.refundAmount),
          findOneEstimate: estimate,
        });
        expect(Number(row.refundAmount)).toBe(minted);
        expect(estimate).toBe(Number(row.refundAmount));
      },
    );

    it("G-F1e: REG-B53 — the latest invoice's room (99.00) still refuses a MULTI pooled 500", async () => {
      const s = await h.seed("gf1e", { older: "B", smallerId: "B" });
      const r = await h.refund(s, (await h.pooled(s, 500)).id);
      log({ case: "G-F1e", result: r });
      expect(r).toMatchObject({ refused: { status: 400 } });
      expect((r as { refused: { message: string } }).refused.message).toMatch(/remaining room 99/);
      expect(await h.creditNoteCount(s)).toBe(0);
    });
  },
);
