/**
 * Row 347 item 3 (real Postgres): a CASH refund of an inline return whose source invoice line was rebuilt after the capture.
 *
 * A post-delivery order edit deletes and recreates the invoice's lines in place (new ids, same order lines), so
 * `ReturnItem.sourceInvoiceItemId` dangles although the goods are still billed. Approve and store credit already re-resolve
 * through the order line (`resolveInlineSourceInvoices`); the cash refund asked the stored id alone and refused 409
 * REFUND_NEEDS_PAID_INVOICE for goods that are paid in full. The refund now uses the SAME resolver, and the paid-in-full,
 * store-credit, remainder and cash-cap checks run on the RE-RESOLVED invoices, under the locks.
 *
 *   R1  rebuilt lines on a PAID invoice: the cash refund succeeds against the live invoice (REFUNDED, CASH, the audit row
 *       names the live invoice).
 *   R2  the cash cap holds on the re-resolved sale: cash 40 + card 60 paid, a $50 cash refund is 409
 *       REFUND_EXCEEDS_CASH_PAID (max 40), a $40 one succeeds.
 *   R3  rebuilt lines then the invoice VOIDED: refused 409 REFUND_NEEDS_PAID_INVOICE, nothing written.
 *   R4  rebuilt lines whose order line was deleted: nothing resolves, refused the same way.
 *   R5  a rebuild that MOVES the line to a sibling invoice while the refund waits for its invoice lock: the re-resolution under
 *       the lock differs from the one the lock set was computed from, so 409 CONCURRENT_UPDATE (retryable), nothing written.
 *   R6  paid with store credit stays store-credit-only after a rebuild (the F4 rule runs on the re-resolved invoice).
 *   R7  the reverse guard follows: after the rotated cash refund, voiding the invoice and cancelling its order are refused
 *       (INVOICE_HAS_CASH_REFUND / ORDER_HAS_CASH_REFUND) although the stored line id no longer names the invoice.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  addInlineReturn,
  cleanupSeeded,
  seedRefundable,
  type SeedInvoice,
  type Seeded,
} from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";
import {
  assertNoCashRefundOnInvoice,
  assertNoCashRefundOnOrder,
} from "../invoices/invoice-cash-refund-guard";

const RUN = randomUUID().slice(0, 8);
const SPEC = "inline-refund-rotated-line.db.spec.ts";

describeDb(
  "row 347 item 3: the cash refund re-resolves a rebuilt source line - real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let inline: any;
    const tenantIds: string[] = [];
    let n = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ({ inline } = await buildRefundServices(prisma, `R347R-${RUN}`));
    }, 120_000);

    afterAll(async () => {
      await cleanupSeeded(prisma, tenantIds);
      await prisma?.$disconnect();
    }, 120_000);

    const sale = (label: string, invoices?: SeedInvoice[]) =>
      seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: SPEC,
        label,
        invoices: invoices ?? [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }],
      });
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
    /** A return captured for a refund (the intent stored): `qty` pieces worth `subtotal` of line 0 of invoice `invoice`. */
    const pendingRefund = (s: Seeded, qty: number, subtotal: number, invoice = 0) =>
      addInlineReturn(prisma, s, {
        number: `RTN-R347R-${RUN}-${++n}`,
        status: "RECEIVED",
        refundMethod: "EXTERNAL_REFUND",
        items: [{ invoice, line: 0, qty, subtotal }],
      });
    const refund = (s: Seeded, returnId: string, expectedAmount: number, tender = "CASH") =>
      tenantCtx
        .run(s.tenantId, () => inline.refund(returnId, { tender, expectedAmount }, staff(s)))
        .then(
          (v: any) => ({ ok: true as const, v }),
          (e: any) => ({ ok: false as const, e }),
        );
    const codeOf = (e: any) => e?.getResponse?.()?.code;
    const row = (id: string) => prisma.return.findUniqueOrThrow({ where: { id } });
    const audits = (s: Seeded) =>
      prisma.auditLog.findMany({ where: { tenantId: s.tenantId, action: "inline_return.refund" } });

    /** What `rebuildSiblingDrafts` does on a post-delivery order edit: the invoice's line is deleted and recreated (new id). */
    const rotate = async (s: Seeded, opts: { invoice?: number; keepOrderLink?: boolean } = {}) => {
      const lineId = s.invoices[opts.invoice ?? 0].lines[0].id;
      const old = await prisma.invoiceItem.findFirstOrThrow({ where: { id: lineId } });
      await prisma.invoiceItem.delete({ where: { id: old.id } });
      return prisma.invoiceItem.create({
        data: {
          tenantId: old.tenantId,
          invoiceId: old.invoiceId,
          orderItemId: opts.keepOrderLink === false ? null : old.orderItemId,
          productId: old.productId,
          description: old.description,
          qty: old.qty,
          unitPrice: old.unitPrice,
          subtotal: old.subtotal,
          taxRate: old.taxRate,
          categoryTaxAmount: old.categoryTaxAmount,
        },
      });
    };

    it("R1: rebuilt lines on a PAID invoice: the cash refund succeeds against the live invoice", async () => {
      const s = await sale("r1");
      const ret = await pendingRefund(s, 5, 50);
      const live = await rotate(s);
      expect(live.id).not.toBe(s.invoices[0].lines[0].id);

      const out = await refund(s, ret.id, 50);

      expect(out.ok).toBe(true);
      const after = await row(ret.id);
      expect(after.status).toBe("REFUNDED");
      expect(after.refundMethod).toBe("EXTERNAL_REFUND");
      expect(after.refundTender).toBe("CASH");
      expect(Number(after.refundAmount)).toBe(50);
      expect(after.refundedAt).not.toBeNull();
      const [audit] = await audits(s);
      expect((audit.meta as any).invoiceIds).toEqual([s.invoices[0].id]);
    }, 60_000);

    it("R2: the cash cap holds on the re-resolved sale (cash 40 + card 60): $50 is 409 REFUND_EXCEEDS_CASH_PAID, $40 succeeds", async () => {
      const s = await sale("r2");
      // split the sale's tender: cash 40 + card 60 (paid in full, so every refund gate but the cap is open)
      await prisma.invoicePayment.updateMany({
        where: { invoiceId: s.invoices[0].id },
        data: { amount: 40 },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoices[0].id,
          amount: 60,
          method: "CREDIT_CARD",
          status: "PAID",
        },
      });
      const over = await pendingRefund(s, 5, 50);
      const fits = await pendingRefund(s, 4, 40);
      await rotate(s);

      const refused = await refund(s, over.id, 50);
      expect(refused.ok).toBe(false);
      expect((refused as any).e?.getStatus?.()).toBe(409);
      expect(codeOf((refused as any).e)).toBe("REFUND_EXCEEDS_CASH_PAID");
      expect((refused as any).e?.getResponse?.().maxCashRefund).toBe(40);
      expect((await row(over.id)).status).toBe("RECEIVED");

      const ok = await refund(s, fits.id, 40);
      expect(ok.ok).toBe(true);
      expect((await row(fits.id)).status).toBe("REFUNDED");
    }, 60_000);

    it("R3: rebuilt lines then the invoice VOIDED: 409 REFUND_NEEDS_PAID_INVOICE, nothing written", async () => {
      const s = await sale("r3");
      const ret = await pendingRefund(s, 5, 50);
      await rotate(s);
      await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { status: "VOID" } });

      const out = await refund(s, ret.id, 50);

      expect(out.ok).toBe(false);
      expect((out as any).e?.getStatus?.()).toBe(409);
      expect(codeOf((out as any).e)).toBe("REFUND_NEEDS_PAID_INVOICE");
      const after = await row(ret.id);
      expect(after.status).toBe("RECEIVED");
      expect(after.refundedAt).toBeNull();
      expect(await audits(s)).toHaveLength(0);
    }, 60_000);

    it("R4: rebuilt lines whose order line was deleted re-resolve to nothing: refused, nothing written", async () => {
      const s = await sale("r4");
      const ret = await pendingRefund(s, 5, 50);
      await rotate(s, { keepOrderLink: false });

      const out = await refund(s, ret.id, 50);

      expect(out.ok).toBe(false);
      expect(codeOf((out as any).e)).toBe("REFUND_NEEDS_PAID_INVOICE");
      const after = await row(ret.id);
      expect(after.status).toBe("RECEIVED");
      expect(await audits(s)).toHaveLength(0);
    }, 60_000);

    it("R5: a rebuild that moves the line to a sibling invoice while the refund waits for its invoice lock: retryable 409, nothing written", async () => {
      const s = await sale("r5", [
        { lines: [{ product: "A", qty: 10, subtotal: 100 }] },
        { lines: [{ product: "A", qty: 5, subtotal: 50 }] },
      ]);
      const ret = await pendingRefund(s, 5, 50, 0);
      const holder = new Client({ connectionString: requireLocalDatabaseUrl() });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoices[0].id]);
        const pending = refund(s, ret.id, 50);
        // wait until the refund is queued behind the invoice lock (it resolved the line to invoice 0 BEFORE locking it)
        let queued = false;
        for (let i = 0; i < 100 && !queued; i++) {
          // pg_stat_activity is a per-transaction snapshot: clear it, or every poll inside the holder's BEGIN reads the first one
          await holder.query("SELECT pg_stat_clear_snapshot()");
          const { rows } = await holder.query(
            `SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND query LIKE '%"Invoice"%FOR UPDATE%'`,
          );
          queued = rows.length > 0;
          if (!queued) await new Promise((r) => setTimeout(r, 50));
        }
        expect(queued).toBe(true);
        // the staff edit lands: the line is rebuilt (new id) on the SIBLING invoice, then the lock is released
        await holder.query(`UPDATE "InvoiceItem" SET id = $1, "invoiceId" = $2 WHERE id = $3`, [
          randomUUID(),
          s.invoices[1].id,
          s.invoices[0].lines[0].id,
        ]);
        await holder.query("COMMIT");

        const out = await pending;

        expect(out.ok).toBe(false);
        expect((out as any).e?.getStatus?.()).toBe(409);
        expect(codeOf((out as any).e)).toBe("CONCURRENT_UPDATE");
        expect((out as any).e?.getResponse?.().retryable).toBe(true);
        const after = await row(ret.id);
        expect(after.status).toBe("RECEIVED");
        expect(after.refundedAt).toBeNull();
        expect(await audits(s)).toHaveLength(0);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
      // and the retry, now that the line sits on the sibling (paid in full too), resolves it there and refunds
      const retry = await refund(s, ret.id, 50);
      expect(retry.ok).toBe(true);
      const [audit] = await audits(s);
      expect((audit.meta as any).invoiceIds).toEqual([s.invoices[1].id]);
    }, 60_000);

    /**
     * ONE order line billed on TWO live invoices (createPartialFromOrder: 6 + 4): `lo` (the lower id, the one the resolver's
     * tie-break prefers) and `hi`, both carrying the SAME order line. A return of 2 pieces ($20) is captured for a refund from
     * `hi`'s line. Returns the indexes into `s.invoices`.
     */
    const splitLine = async (label: string) => {
      const s = await sale(label, [
        { lines: [{ product: "A", qty: 6, subtotal: 60 }] },
        { lines: [{ product: "A", qty: 4, subtotal: 40 }] },
      ]);
      const lo = s.invoices[0].id < s.invoices[1].id ? 0 : 1;
      const hi = 1 - lo;
      const shared = s.invoices[lo].lines[0].orderItemId;
      await prisma.invoiceItem.update({
        where: { id: s.invoices[hi].lines[0].id },
        data: { orderItemId: shared },
      });
      const ret = await pendingRefund(s, 2, 20, hi);
      await prisma.returnItem.updateMany({
        where: { returnId: ret.id },
        data: { sourceOrderItemId: shared },
      });
      s.invoices[hi].lines[0].orderItemId = shared;
      return { s, ret, lo, hi };
    };

    it("R8: one order line on TWO live invoices, the invoice the goods were on owing after a rebuild: refused (never paid against the other)", async () => {
      const { s, ret, hi } = await splitLine("r8");
      // after the capture: the goods' invoice goes unpaid (its payment voided) and a staff edit rebuilds its lines
      await prisma.invoicePayment.updateMany({
        where: { invoiceId: s.invoices[hi].id },
        data: { status: "VOID" },
      });
      await rotate(s, { invoice: hi });

      const out = await refund(s, ret.id, 20);

      expect(out.ok).toBe(false);
      expect((out as any).e?.getStatus?.()).toBe(409);
      expect(codeOf((out as any).e)).toBe("REFUND_NEEDS_PAID_INVOICE");
      const after = await row(ret.id);
      expect(after.status).toBe("RECEIVED");
      expect(after.refundedAt).toBeNull();
      expect(await audits(s)).toHaveLength(0);
    }, 60_000);

    it("R8b: a VOIDED sibling that carries the same order line also refuses the cash (fail closed), the exit is store credit", async () => {
      const { s, ret, lo } = await splitLine("r8b");
      await prisma.invoice.update({ where: { id: s.invoices[lo].id }, data: { status: "VOID" } });
      await rotate(s, { invoice: 1 - lo });

      const out = await refund(s, ret.id, 20);

      expect(out.ok).toBe(false);
      expect(codeOf((out as any).e)).toBe("REFUND_NEEDS_PAID_INVOICE");
      expect((await row(ret.id)).status).toBe("RECEIVED");
    }, 60_000);

    it("R8 control: the same split with BOTH invoices paid in full still refunds, and the audit names both candidate invoices", async () => {
      const { s, ret } = await splitLine("r8c");
      await rotate(s, { invoice: s.invoices[0].id < s.invoices[1].id ? 1 : 0 });

      const out = await refund(s, ret.id, 20);

      expect(out.ok).toBe(true);
      expect((await row(ret.id)).status).toBe("REFUNDED");
      const [audit] = await audits(s);
      expect((audit.meta as any).invoiceIds).toEqual([s.invoices[0].id, s.invoices[1].id].sort());
    }, 60_000);

    it("R6: paid with store credit stays store-credit-only after a rebuild (F4 runs on the re-resolved invoice)", async () => {
      const s = await sale("r6");
      await prisma.invoicePayment.updateMany({
        where: { invoiceId: s.invoices[0].id },
        data: { method: "ADVANCE" },
      });
      const ret = await pendingRefund(s, 5, 50);
      await rotate(s);

      const out = await refund(s, ret.id, 50);

      expect(out.ok).toBe(false);
      expect(codeOf((out as any).e)).toBe("REFUND_PAID_WITH_STORE_CREDIT");
      expect((await row(ret.id)).status).toBe("RECEIVED");
    }, 60_000);

    it("R9: a cash refund of goods on partial invoice B does not block voiding sibling A that shares the order line (B itself stays blocked)", async () => {
      const { s, ret, lo, hi } = await splitLine("r9");
      expect((await refund(s, ret.id, 20)).ok).toBe(true);
      const guard = (invoiceId: string) =>
        tenantCtx
          .run(s.tenantId, () =>
            prisma.tenantTransaction((tx: any) =>
              assertNoCashRefundOnInvoice(tx, invoiceId, s.orderId),
            ),
          )
          .then(
            () => null,
            (e: any) => e,
          );

      // the stored line is ALIVE on B: A's void is as allowed as it was before the order-line clause existed
      expect(await guard(s.invoices[lo].id)).toBeNull();
      expect(codeOf(await guard(s.invoices[hi].id))).toBe("INVOICE_HAS_CASH_REFUND");
    }, 60_000);

    it("R7: the reverse guard follows the rotation: a rotated cash refund blocks the invoice void and the order cancel", async () => {
      const s = await sale("r7");
      const ret = await pendingRefund(s, 5, 50);
      await rotate(s);
      expect((await refund(s, ret.id, 50)).ok).toBe(true);

      const onInvoice = await tenantCtx
        .run(s.tenantId, () =>
          prisma.tenantTransaction((tx: any) =>
            assertNoCashRefundOnInvoice(tx, s.invoices[0].id, s.orderId),
          ),
        )
        .then(
          () => null,
          (e: any) => e,
        );
      expect(codeOf(onInvoice)).toBe("INVOICE_HAS_CASH_REFUND");

      const onOrder = await tenantCtx
        .run(s.tenantId, () =>
          prisma.tenantTransaction((tx: any) => assertNoCashRefundOnOrder(tx, s.orderId)),
        )
        .then(
          () => null,
          (e: any) => e,
        );
      expect(codeOf(onOrder)).toBe("ORDER_HAS_CASH_REFUND");
    }, 60_000);
  },
);
