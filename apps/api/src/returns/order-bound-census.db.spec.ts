/**
 * SA-1091 piece 1: the OLD-ROWS census (`censusOrderBound`) on REAL Postgres, scoped to one throwaway tenant. It reads the
 * order-wide bound through `loadOrderRefundRoom` itself and the stored inline gross against `refundableLineShare`, and it
 * reports counts and buckets only. Read-only: the spec seeds rows, runs the census, and the census writes nothing.
 *
 *   OB-1  an order that gave back less than it billed                         -> scanned, NOT over
 *   OB-2  a lump note 70.00 + a recorded standard refund 40.00 on a 100.00 invoice  -> over by 10.00 (over a dollar);
 *         the givers are the note and the recorded refund, not the inline
 *   OB-3  a lump note past the bill by a cent                                  -> over, the one-cent bucket
 *   OB-4  a lump note past the bill by 0.50                                    -> over, the up-to-a-dollar bucket
 *   OB-5  a VOID note does not count, so the same order is not over            -> NOT over
 *   OB-5b a recorded refund of 100.40 on a 100.00 invoice, no note at all       -> over (the standard-return scan alone finds it)
 *   OB-6  a billed 108.00 line (100.00 + 8.00 tax) with a stored inline gross of 108.01 -> one invoice and one line past,
 *         the one-cent bucket
 *   OB-7  a stored inline gross of exactly 108.00, and a CANCELLED inline row of 50.00 on top -> NOT past
 *   OB-8  an inline row on a VOID invoice                                      -> not read at all
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`).
 * SAFETY: a throwaway `qa-ob-<run>` tenant approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  censusOrderBound,
  type CensusOptions,
  type OrderBoundCensus,
  type Reader,
} from "./order-bound-census";
import { loadOrderRefundRoom, loadOrderRefundRooms } from "../credit-notes/line-credit-headroom";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1091 piece 1: the old-rows census", () => {
  let prisma: PrismaService;
  let tenantId = "";
  let customerId = "";
  let productId = "";
  let n = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-ob-${RUN}`, "order-bound-census.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `ob ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "c ob", contactName: "c ob", tenantId },
      })
    ).id;
    productId = (
      await prisma.product.create({
        data: {
          tenantId,
          name: `P ${slug}`,
          unit: "each",
          pricePerUnit: 10,
          unitsPerBox: 1,
        } as any,
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const where = { tenantId };
    await prisma.returnItem.deleteMany({ where });
    await prisma.return.deleteMany({ where });
    await prisma.creditNote.deleteMany({ where });
    await prisma.invoiceItem.deleteMany({ where });
    await prisma.invoice.deleteMany({ where });
    await prisma.orderItem.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  /** A delivered order with ONE invoice of one line: `net` + `tax` billed, no discount. */
  async function sale(net: number, tax = 0, status: "SENT" | "VOID" = "SENT") {
    n += 1;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        orderNumber: `ORD-OB-${RUN}-${n}`,
        subtotal: net,
        tax,
        total: net + tax,
        status: "DELIVERED",
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId: order.id,
        invoiceNumber: `INV-OB-${RUN}-${n}`,
        status,
        subtotal: net,
        taxAmount: tax,
        discount: 0,
        total: net + tax,
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId,
        name: "P",
        position: 0,
        qty: 10,
        unitPrice: net / 10,
        subtotal: net,
        boxes: 10,
        pieces: 0,
        unitsPerBox: 1,
      } as any,
    });
    const line = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        orderItemId: orderItem.id,
        productId,
        description: "P",
        qty: 10,
        unitPrice: net / 10,
        subtotal: net,
        taxRate: net > 0 ? tax / net : 0,
        boxes: 10,
        pieces: 0,
        unitsPerBox: 1,
      } as any,
    });
    return { order, invoice, line };
  }

  const note = (
    s: { invoice: { id: string }; order: { id: string } },
    amount: number,
    status = "ISSUED",
  ) =>
    prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        invoiceId: s.invoice.id,
        creditNoteNumber: `CN-OB-${RUN}-${++n}`,
        amount,
        status,
        reason: "goodwill",
      } as any,
    });

  const recordedRefund = (s: { order: { id: string } }, amount: number) =>
    prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId: s.order.id,
        returnNumber: `RET-OB-${RUN}-${++n}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: "STANDARD",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: amount,
      } as any,
    });

  async function inline(
    s: { order: { id: string }; line: { id: string } },
    gross: { net: number; tax: number },
    status = "REFUNDED",
  ) {
    const ret = await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId: s.order.id,
        returnNumber: `RET-OB-${RUN}-${++n}`,
        reason: "DAMAGED",
        status,
        kind: "INLINE",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: gross.net + gross.tax,
      } as any,
    });
    await prisma.returnItem.create({
      data: {
        tenantId,
        returnId: ret.id,
        productId,
        qty: 1,
        sourceInvoiceItemId: s.line.id,
        subtotal: gross.net,
        taxAmount: gross.tax,
        categoryTax: 0,
      } as any,
    });
  }

  // each read is its own transaction, as the runner does it (the runner's read-only proof is its own spec)
  const read: Reader = (fn) => prisma.$transaction((tx) => fn(tx));
  const run = (opts: CensusOptions = {}): Promise<OrderBoundCensus> =>
    censusOrderBound(read, { tenantId, ...opts });

  it("OB-1..OB-5: an order is over only when what it gave back passes what it billed", async () => {
    const fine = await sale(100);
    await note(fine, 40);
    const over = await sale(100);
    await note(over, 70);
    await recordedRefund(over, 40);
    const cent = await sale(100);
    await note(cent, 100.01);
    const half = await sale(100);
    await note(half, 100.5);
    const voided = await sale(100);
    await note(voided, 100);
    await note(voided, 60, "VOID");
    const onlyRecorded = await sale(100); // no note at all: only the standard-return scan can find it
    await recordedRefund(onlyRecorded, 100.4);

    const r = await run();
    expect(r.orders.scanned).toBe(6);
    expect(r.orders.noBound).toBe(0);
    expect(r.orders.overBound).toBe(4);
    expect(r.orders.overBy).toEqual({ upToOneCent: 1, upToOneDollar: 2, overOneDollar: 1 });
    // OB-2's givers are the note and the recorded refund; OB-3 and OB-4 are notes alone; the sixth order has a recorded refund only
    expect(r.orders.overBoundGivers).toEqual({ notes: 3, unlinked: 0, recorded: 2, inline: 0 });
    expect(r.denominators.creditableInvoicesWithLiveNotes).toBe(5);
    expect(r.denominators.liveStandardReturnOrders).toBe(2);
  });

  it("OB-6..OB-8: an invoice is past its charge only when the stored inline gross passes what its lines charged", async () => {
    const past = await sale(100, 8);
    await inline(past, { net: 100, tax: 8.01 });
    const exact = await sale(100, 8);
    await inline(exact, { net: 100, tax: 8 });
    await inline(exact, { net: 50, tax: 4 }, "CANCELLED");
    const voided = await sale(100, 8, "VOID");
    await inline(voided, { net: 100, tax: 9 });

    const r = await run();
    expect(r.denominators.liveInlineReturnItems).toBe(3); // the cancelled row is not live
    expect(r.inline.invoicesWithInline).toBe(2); // the void invoice's row is not read
    expect(r.inline.invoicesPastCharge).toBe(1);
    expect(r.inline.invoicesPastBy).toEqual({ upToOneCent: 1, upToOneDollar: 0, overOneDollar: 0 });
    expect(r.inline.linesPastCharge).toBe(1);
    expect(r.inline.invoicesUnreadable).toBe(0);
  });

  it("prints counts and buckets only: nothing in the result names a tenant, order, invoice or amount", async () => {
    const r = await run();
    const text = JSON.stringify(r);
    expect(text).not.toContain(tenantId);
    for (const v of Object.values(r.orders.overBy)) expect(Number.isInteger(v)).toBe(true);
  });

  // ── the shape that fixed the production timeout ─────────────────────────────────────────────────────────────────────

  /** A client whose findMany calls are counted: the census must not read per order. */
  function counting(db: any) {
    let n = 0;
    const wrap = (model: any) =>
      new Proxy(model, {
        get(t, k) {
          const v = t[k];
          if (k !== "findMany") return v;
          return (...a: unknown[]) => {
            n += 1;
            return v.apply(t, a);
          };
        },
      });
    const proxy = new Proxy(db, {
      get(t, k) {
        const v = t[k];
        return v && typeof v === "object" && typeof v.findMany === "function" ? wrap(v) : v;
      },
    });
    return { db: proxy, reads: () => n };
  }

  async function anchorsOfTenant() {
    const orders = await prisma.order.findMany({ where: { tenantId }, select: { id: true } });
    const loose = await prisma.invoice.findMany({
      where: { tenantId, orderId: null },
      select: { id: true },
    });
    return [...orders.map((o) => ({ orderId: o.id })), ...loose.map((i) => ({ invoiceId: i.id }))];
  }

  it("OB-9: batch size and page size change nothing but the number of reads", async () => {
    const whole = await run();
    expect(await run({ pageSize: 2, anchorBatch: 2 })).toEqual(whole);
    expect(await run({ pageSize: 1, anchorBatch: 1, sliceMs: 0 })).toEqual(whole);
  });

  it("OB-10: the batch read gives the live helper's figure for every kind of giver", async () => {
    // lump note + inline whose own note sits on the invoice (counted once), a refund note minted before invoicing (SA-1053),
    // a recorded refund, a void note, an invoice with no order, a never-credited order
    const dup = await sale(100, 8);
    const dupNote = await note(dup, 30);
    await inline(dup, { net: 20, tax: 1.6 });
    // the inline return's own refund note sits on the invoice too: it is counted by the return, never twice
    await prisma.return.updateMany({
      where: { orderId: dup.order.id, kind: "INLINE" },
      data: { creditNoteId: dupNote.id },
    });
    await note(dup, 10, "VOID");
    await recordedRefund(dup, 15);
    const early = await sale(100);
    const store = await prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        invoiceId: null,
        creditNoteNumber: `CN-OB-${RUN}-${++n}`,
        amount: 25,
        status: "ISSUED",
        reason: "refund",
      } as any,
    });
    await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId: early.order.id,
        returnNumber: `RET-OB-${RUN}-${++n}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: "STANDARD",
        refundMethod: "STORE_CREDIT",
        refundAmount: 25,
        creditNoteId: store.id,
      } as any,
    });
    await sale(100); // never credited
    await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId: null,
        invoiceNumber: `INV-OB-${RUN}-${++n}`,
        status: "SENT",
        subtotal: 50,
        taxAmount: 0,
        discount: 0,
        total: 50,
      },
    });
    const anchors = await anchorsOfTenant();
    expect(anchors.length).toBeGreaterThan(10);

    const batch = await loadOrderRefundRooms(prisma, anchors);
    expect(batch).toHaveLength(anchors.length);
    for (let i = 0; i < anchors.length; i++)
      expect({ anchor: anchors[i], room: batch[i] }).toEqual({
        anchor: anchors[i],
        room: await loadOrderRefundRoom(prisma, anchors[i]),
      });
    // the kinds above really are in the comparison
    const byOrder = new Map(anchors.map((a, i) => [(a as any).orderId, batch[i]]));
    expect(byOrder.get(early.order.id)?.given.unlinked).toBe(25);
    expect(byOrder.get(dup.order.id)?.given).toMatchObject({
      notes: 0,
      recorded: 15,
      inline: 21.6,
    });
  });

  it("OB-11: the bound is read in a fixed number of reads, not a handful per order", async () => {
    const all = await anchorsOfTenant();
    const many = counting(prisma);
    await loadOrderRefundRooms(many.db, all);
    // 10+ anchors; the old per-order reads were about eight each (80+). The batch is a fixed set of keyed reads.
    expect(all.length).toBeGreaterThan(10);
    expect(many.reads()).toBeLessThanOrEqual(12);
  });
});
