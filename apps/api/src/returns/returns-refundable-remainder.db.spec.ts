/**
 * SA-773: the refund paths against stored rows on real Postgres. Rows are seeded DIRECTLY (a credit note item and a return that
 * the capture-time guards would have refused had they met in time: older data, or the window between a check and a write), so
 * what is proven is the refund's own check under its locks, not the capture's.
 *
 *   T1  a $20 credit note item on the whole line, then a RECEIVED inline return of that line: the cash refund is 409
 *       RETURN_EXCEEDS_REFUNDABLE with remainingValue 0 and the return stays RECEIVED. Before this change the refund
 *       succeeded: $40 out for $20 of goods.
 *   T2  a partial credit note ($8 of $20): a return of the remaining $12 refunds; a return of $13 is refused, remainingValue 12.
 *   T3  an amount-only invoice credit note of $15 on a $50 invoice: an inline return of both products ($50) is refused at the
 *       invoice, remainingValue 35 and remainingQty null.
 *   T4  store credit instead of a refund is checked the same way.
 *   T5  a STANDARD return reserved by another RECEIVED return of the same goods: the refund is 409; a REJECTED one reserves
 *       nothing, so the refund then goes through (store credit minted).
 *   T6  the check is made under the invoice lock: a credit note committed by the lock holder while the refund waited is seen.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { ReturnsService } from "./returns.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  addCreditNote,
  addInlineReturn,
  addStandardReturn,
  cleanupSeeded,
  seedRefundable,
  type Seeded,
  type SeedInvoice,
} from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);
const SPEC = "returns-refundable-remainder.db.spec.ts";

describeDb("SA-773 the refund paths read the refundable remainder - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inline: any;
  let returns: ReturnsService;
  let ctl: any; // a raw connection that only watches pg_stat_activity
  const tenantIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ctl = new Client({ connectionString: url });
    await ctl.connect();
    ({ inline, returns } = await buildRefundServices(prisma, `SA773B-${RUN}`));
  }, 120_000);

  afterAll(async () => {
    await cleanupSeeded(prisma, tenantIds);
    await ctl?.end().catch(() => undefined);
    await prisma?.$disconnect();
  }, 120_000);

  const seed = (label: string, invoices: SeedInvoice[]) =>
    seedRefundable(prisma, tenantIds, { run: RUN, spec: SPEC, label, invoices });
  const staff = (s: Seeded) =>
    ({
      sub: s.userId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: s.tenantId,
      tenantSlug: "x",
    }) as any;
  const asTenant = <T>(s: Seeded, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const cashRefund = (s: Seeded, returnId: string, expectedAmount: number) =>
    asTenant(s, () => inline.refund(returnId, { tender: "CASH", expectedAmount }, staff(s)));
  const storeCreditInstead = (s: Seeded, returnId: string) =>
    asTenant(s, () => inline.storeCreditInstead(returnId, staff(s)));
  const standardRefund = (s: Seeded, returnId: string) =>
    asTenant(s, () => returns.processRefund(returnId, { method: "CREDIT_NOTE" } as any, staff(s)));
  const fail = (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => undefined,
      (e) => e,
    );
  const body = (e: any) => e?.getResponse?.() ?? {};
  const row = (id: string) => prisma.return.findUniqueOrThrow({ where: { id } });
  const cn = () => `CN-SA773B-SEED-${RUN}-${++n}`;
  const rtn = () => `RTN-SA773B-${RUN}-${++n}`;
  const pendingRefund = (s: Seeded, items: Parameters<typeof addInlineReturn>[2]["items"]) =>
    addInlineReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      refundMethod: "EXTERNAL_REFUND",
      items,
    });

  it("T1: a $20 credit note item on the whole line, then a cash refund of the same goods: 409, remainingValue 0, return untouched", async () => {
    const s = await seed("t1", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 4 }] });
    const ret = await pendingRefund(s, [{ line: 0, qty: 4, subtotal: 20 }]);
    const err = await fail(cashRefund(s, ret.id, 20));
    expect(err?.getStatus?.()).toBe(409);
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      invoiceId: s.invoices[0].id,
      productId: s.products.A,
      remainingQty: 0,
      remainingValue: 0,
    });
    const after = await row(ret.id);
    expect([after.status, after.refundedAt]).toEqual(["RECEIVED", null]);
    expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId } })).toBe(0);
  });

  it("T2: $8 of the $20 line already credited: a return of the remaining $12 refunds; one of $13 is refused with $12 left", async () => {
    const ok = await seed("t2a", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, ok, { number: cn(), items: [{ line: 0, amount: 8, qty: 1.6 }] });
    const fits = await pendingRefund(ok, [{ line: 0, qty: 2.4, subtotal: 12 }]);
    await cashRefund(ok, fits.id, 12);
    expect((await row(fits.id)).status).toBe("REFUNDED");

    const over = await seed("t2b", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, over, { number: cn(), items: [{ line: 0, amount: 8, qty: 1.6 }] });
    const tooMuch = await pendingRefund(over, [{ line: 0, qty: 2.4, subtotal: 13 }]);
    const err = await fail(cashRefund(over, tooMuch.id, 13));
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingValue: 12 });
    expect((await row(tooMuch.id)).status).toBe("RECEIVED");
  });

  it("T3: an amount-only credit note of $15 on a $50 invoice caps the invoice at $35 across its products", async () => {
    const s = await seed("t3", [
      {
        lines: [
          { product: "A", qty: 5, subtotal: 30 },
          { product: "B", qty: 2, subtotal: 20 },
        ],
      },
    ]);
    await addCreditNote(prisma, s, { number: cn(), invoice: 0, amount: 15 });
    const ret = await pendingRefund(s, [
      { line: 0, qty: 5, subtotal: 30 },
      { line: 1, qty: 2, subtotal: 20 },
    ]);
    const err = await fail(cashRefund(s, ret.id, 50));
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      invoiceId: s.invoices[0].id,
      remainingQty: null,
      remainingValue: 35,
    });
  });

  it("T4: store credit instead of a refund is held to the same remainder: 409, nothing minted, the refund intent kept", async () => {
    const s = await seed("t4", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 4 }] });
    const ret = await pendingRefund(s, [{ line: 0, qty: 4, subtotal: 20 }]);
    const err = await fail(storeCreditInstead(s, ret.id));
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingValue: 0 });
    const after = await row(ret.id);
    expect([after.status, after.refundMethod, after.creditNoteId]).toEqual([
      "RECEIVED",
      "EXTERNAL_REFUND",
      null,
    ]);
    expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1); // only the seeded one
  });

  it("T5: a STANDARD refund of goods another RECEIVED return already reserves is 409; a REJECTED one reserves nothing", async () => {
    const s = await seed("t5a", [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }]);
    await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 6 }],
    });
    const mine = await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 6 }],
    });
    const err = await fail(standardRefund(s, mine.id));
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      productId: s.products.A,
      remainingQty: 4,
      remainingValue: 40,
    });
    expect((await row(mine.id)).status).toBe("RECEIVED");

    const free = await seed("t5b", [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }]);
    await addStandardReturn(prisma, free, {
      number: rtn(),
      status: "REJECTED",
      items: [{ product: "A", qty: 6 }],
    });
    const ok = await addStandardReturn(prisma, free, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 6 }],
    });
    await standardRefund(free, ok.id);
    const done = await row(ok.id);
    expect(done.status).toBe("REFUNDED");
    expect(done.creditNoteId).not.toBeNull();
  });

  it("T7: a TAXED line is refunded in two real captures (3 + 7 of 10 at 8.25%) without the gross remainder refusing either, and a third piece is refused", async () => {
    const s = await seed("t7", [
      { lines: [{ product: "A", qty: 10, subtotal: 33.33, taxRate: 0.0825 }] },
    ]);
    // the invoice charged tax, so the captures price it at the line's stored rate
    await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { taxAmount: 2.75 } });
    const capture = async (pieces: number): Promise<any> =>
      asTenant(s, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: s.orderId,
            items: [{ productId: s.products.A, qty: pieces, boxes: 0, pieces }],
            returnKey: `t7-${RUN}-${++n}`,
            resolution: "REFUND",
          },
          staff(s),
        ),
      );
    const total = (r: any) =>
      Math.round(
        (Number(r.creditSubtotal) + Number(r.creditTax) + Number(r.creditCategoryTax)) * 100,
      ) / 100;
    const a = await capture(3);
    await cashRefund(s, a.id, total(a));
    const b = await capture(7);
    await cashRefund(s, b.id, total(b));
    expect([(await row(a.id)).status, (await row(b.id)).status]).toEqual(["REFUNDED", "REFUNDED"]);
    // the two refunds together are the line's full gross ($33.33 + $2.75): nothing is left
    expect(Math.round((total(a) + total(b)) * 100) / 100).toBe(36.08);
    const more = await pendingRefund(s, [{ line: 0, qty: 1, subtotal: 3.33, taxAmount: 0.27 }]);
    const err = await fail(cashRefund(s, more.id, 3.6));
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingQty: 0 });
  });

  const standardCashRefund = (s: Seeded, returnId: string) =>
    asTenant(s, () =>
      returns.processRefund(
        returnId,
        { method: "EXTERNAL_REFUND", tender: "CASH" } as any,
        staff(s),
      ),
    );

  it("T8: a mixed-price pool: the premium pieces went out inline ($100), the other 10 fit by qty but are priced at the $5.50 average ($55) against $10 left: 409 on the pool's VALUE", async () => {
    const s = await seed("t8", [
      {
        lines: [
          { product: "A", qty: 10, subtotal: 10 },
          { product: "A", qty: 10, subtotal: 100 },
          { product: "B", qty: 1, subtotal: 200 },
        ],
      },
    ]);
    await addInlineReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ line: 1, qty: 10, subtotal: 100 }],
    });
    const mine = await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 10 }],
    });
    const err = await fail(standardCashRefund(s, mine.id));
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      productId: s.products.A,
      remainingQty: 10, // the qty passes: only the value can refuse
      remainingValue: 10,
    });
    expect((await row(mine.id)).status).toBe("RECEIVED");
  });

  it("T12: the preview of that same T8 return shows the $10 the claim would accept, not the $55 it would refuse", async () => {
    const s = await seed("t12", [
      {
        lines: [
          { product: "A", qty: 10, subtotal: 10 },
          { product: "A", qty: 10, subtotal: 100 },
        ],
      },
    ]);
    await addInlineReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ line: 1, qty: 10, subtotal: 100 }],
    });
    const mine = await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 10 }],
    });
    const view: any = await asTenant(s, () => returns.findOne(mine.id));
    expect(view.refundEstimate).toBe(10);
    expect(view.refundEstimateReason).toBe("EXCEEDS_REFUNDABLE");
    const err = await fail(standardCashRefund(s, mine.id)); // and the claim itself still refuses (it is never clamped)
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingValue: 10 });
  });

  it("T9: a credit note item with an explicit qty of 0.001 that took the whole $20 line: a cash refund of the line's units is refused on VALUE (the qty has 9.999 left)", async () => {
    const s = await seed("t9", [{ lines: [{ product: "A", qty: 10, subtotal: 20 }] }]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 0.001 }] });
    const mine = await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 9.99 }],
    });
    const err = await fail(standardCashRefund(s, mine.id));
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      productId: s.products.A,
      remainingValue: 0,
    });
    expect(body(err).remainingQty).toBeGreaterThan(9.9);
    expect((await row(mine.id)).status).toBe("RECEIVED");
  });

  it("T10: a $50 amount-only credit note on a $50 invoice, then a counter return of all its goods as STORE CREDIT: 409 at capture, nothing minted (it used to mint $50 more)", async () => {
    const s = await seed("t10", [{ lines: [{ product: "A", qty: 5, subtotal: 50 }] }]);
    await addCreditNote(prisma, s, { number: cn(), invoice: 0, amount: 50 });
    const err = await fail(
      asTenant(s, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: s.orderId,
            items: [{ productId: s.products.A, qty: 5, boxes: 0, pieces: 5 }],
            returnKey: `t10-${RUN}-${++n}`,
          },
          staff(s),
        ),
      ),
    );
    expect(body(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      invoiceId: s.invoices[0].id,
      remainingValue: 0,
    });
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1); // only the seeded manual note
  });

  it("T11: the same goods with a $20 manual credit: the capture is refused with $30 left, and a return of the $30 worth of goods mints", async () => {
    const s = await seed("t11", [{ lines: [{ product: "A", qty: 5, subtotal: 50 }] }]);
    await addCreditNote(prisma, s, { number: cn(), invoice: 0, amount: 20 });
    const capture = (pieces: number): Promise<any> =>
      asTenant(s, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: s.orderId,
            items: [{ productId: s.products.A, qty: pieces, boxes: 0, pieces }],
            returnKey: `t11-${RUN}-${++n}`,
          },
          staff(s),
        ),
      );
    const err = await fail(capture(5));
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingValue: 30 });
    const ok = await capture(3); // $30
    expect(ok.status).toBeDefined();
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(1);
  });

  it("T6: the check is made under the invoice lock: a credit note the lock holder commits while the refund waits is seen", async () => {
    const s = await seed("t6", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    const ret = await pendingRefund(s, [{ line: 0, qty: 4, subtotal: 20 }]);
    const poll = async (min: number): Promise<boolean> => {
      for (let i = 0; i < 200; i++) {
        const r = await ctl.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (r.rows[0].n >= min) return true;
        await new Promise((x) => setTimeout(x, 25));
      }
      return false;
    };
    let refund: Promise<any> | undefined;
    let waited = false;
    // the holder takes the Order and the invoice (the refund's first two row locks after its own Return), writes a credit note that
    // takes the whole line, and commits only once the refund is queued behind it
    await prisma.$transaction(
      async (tx: any) => {
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${s.orderId} FOR UPDATE`;
        await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${s.invoices[0].id} FOR UPDATE`;
        await addCreditNote(tx, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 4 }] });
        refund = fail(cashRefund(s, ret.id, 20));
        waited = await poll(1);
      },
      { timeout: 30_000 },
    );
    const err = await refund;
    expect(waited).toBe(true);
    expect(body(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingValue: 0 });
    expect((await row(ret.id)).status).toBe("RECEIVED");
  });
});
