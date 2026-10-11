/**
 * Row 347 item 1 (real Postgres): the standalone capture() of a STORE_CREDIT return is ONE transaction, capture AND mint.
 *
 * Before: capture committed (return created, goods restocked, ledger reversed) and the credit was minted in a SECOND
 * transaction. A void / line loss that landed between the two made the mint refuse 409 RETURN_NOTHING_BILLED for a return
 * that EXISTS and is committed. Now the mint is composed into the capture's own transaction (captureAndIssueInTx), under the
 * Orders and source invoices the capture already holds, so there is no window: either the return and its credit both exist,
 * or neither does (and the caller sees the refusal, with nothing restocked).
 *
 *   A1  a VOID landing right after the capture's transaction: ONE transaction ran, the return is REFUNDED with its note.
 *   A2  a source line rebuilt (new ids, order line kept) right after it: the same; the credit stands.
 *   A3  a rebuild that also loses the order line: the same (nothing between capture and mint to refuse).
 *   B1  a VOID landing AFTER the pricing read, BEFORE the invoice locks (inside the transaction): 409 RETURN_NOTHING_BILLED,
 *       and NOTHING is written: no return, no stock moved, no note (the old order left a committed, restocked return).
 *   B2  a rebuild that keeps the order line landing there: re-resolved through the order line, the capture and the credit succeed.
 *   C   the mint failing rolls the WHOLE capture back (no return, no stock); the same-key retry then mints exactly once.
 *   D   a same-key replay of a finished capture returns the existing credit note and never mints a second one.
 *   E   a REFUND-resolution capture never mints (its intent is stored for the refund endpoint); the DRIVER_CAP hold is covered by
 *       inline-returns-capture-concurrency.db.spec.ts, which this composition keeps green.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { cleanupSeeded, seedRefundable, type Seeded } from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

const RUN = randomUUID().slice(0, 8);
const SPEC = "inline-capture-atomic-mint.db.spec.ts";

describeDb("row 347 item 1: capture + mint are one transaction - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inline: any;
  let creditNotes: any;
  const tenantIds: string[] = [];
  let keySeq = 0;

  // hooks the tests arm; the wrappers below fire them at the exact seam
  let afterFirstTransaction: (() => Promise<void>) | null = null;
  let afterTxPricing: (() => Promise<void>) | null = null;
  let txDepth = 0;
  let transactions = 0;
  const realTx = PrismaService.prototype.tenantTransaction;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ({ inline, creditNotes } = await buildRefundServices(prisma, `R347-${RUN}`));

    const price = inline.quoteService.priceInlineReturn.bind(inline.quoteService);
    inline.quoteService.priceInlineReturn = async (...args: any[]) => {
      const out = await price(...args);
      if (txDepth > 0 && afterTxPricing) {
        const h = afterTxPricing;
        afterTxPricing = null;
        await h();
      }
      return out;
    };
    (prisma as any).tenantTransaction = async function (this: any, ...args: any[]) {
      transactions += 1;
      txDepth += 1;
      try {
        return await (realTx as any).apply(prisma, args);
      } finally {
        txDepth -= 1;
        if (txDepth === 0 && afterFirstTransaction) {
          const h = afterFirstTransaction;
          afterFirstTransaction = null;
          await h();
        }
      }
    };
  }, 120_000);

  afterEach(() => {
    afterFirstTransaction = null;
    afterTxPricing = null;
    transactions = 0;
  });

  afterAll(async () => {
    (prisma as any).tenantTransaction = realTx;
    await cleanupSeeded(prisma, tenantIds);
    await prisma?.$disconnect();
  }, 120_000);

  const sale = (label: string) =>
    seedRefundable(prisma, tenantIds, {
      run: RUN,
      spec: SPEC,
      label,
      invoices: [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }],
    });
  const staff = (s: Seeded, role = "OPERATOR") =>
    ({
      sub: s.userId,
      username: role.toLowerCase(),
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: s.tenantId,
      tenantSlug: "x",
    }) as any;
  const capture = (
    s: Seeded,
    opts: { pieces?: number; key?: string; resolution?: "REFUND"; role?: string } = {},
  ) =>
    tenantCtx.run(s.tenantId, () =>
      inline.capture(
        {
          customerId: s.customerId,
          orderId: s.orderId,
          items: [
            { productId: s.products.A, qty: opts.pieces ?? 4, boxes: 0, pieces: opts.pieces ?? 4 },
          ],
          returnKey: opts.key ?? `r347-${RUN}-${++keySeq}`,
          ...(opts.resolution ? { resolution: opts.resolution } : {}),
        },
        staff(s, opts.role),
      ),
    );
  const settle = (p: Promise<any>) =>
    p.then(
      (v) => ({ ok: true as const, v }),
      (e: any) => ({ ok: false as const, e }),
    );
  const codeOf = (e: any) => e?.getResponse?.()?.code;
  const state = async (s: Seeded) => ({
    returns: await prisma.return.findMany({ where: { tenantId: s.tenantId } }),
    notes: await prisma.creditNote.findMany({ where: { tenantId: s.tenantId } }),
    stock: Number(
      (await prisma.product.findUniqueOrThrow({ where: { id: s.products.A } })).currentStock ?? 0,
    ),
  });
  const voidInvoice = (s: Seeded) => async () => {
    await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { status: "VOID" } });
  };
  /** What `rebuildSiblingDrafts` does on a post-delivery order edit: the invoice's lines are deleted and recreated. */
  const rotate =
    (s: Seeded, opts: { dropOrderLine?: boolean } = {}) =>
    async () => {
      const old = await prisma.invoiceItem.findFirstOrThrow({
        where: { id: s.invoices[0].lines[0].id },
      });
      await prisma.invoiceItem.delete({ where: { id: old.id } });
      await prisma.invoiceItem.create({
        data: {
          tenantId: old.tenantId,
          invoiceId: old.invoiceId,
          orderItemId: old.orderItemId,
          productId: old.productId,
          description: old.description,
          qty: old.qty,
          unitPrice: old.unitPrice,
          subtotal: old.subtotal,
          taxRate: old.taxRate,
          categoryTaxAmount: old.categoryTaxAmount,
        },
      });
      if (opts.dropOrderLine && old.orderItemId)
        await prisma.orderItem.delete({ where: { id: old.orderItemId } });
    };

  it("A1: a void landing right after the capture's transaction: ONE transaction ran, REFUNDED with its $40 note", async () => {
    const s = await sale("a1");
    afterFirstTransaction = voidInvoice(s);

    const out = await settle(capture(s));
    expect(out.ok).toBe(true);
    const after = await state(s);
    expect(after.returns).toHaveLength(1);
    expect(after.returns[0].status).toBe("REFUNDED");
    expect(after.returns[0].creditNoteId).toBe(after.notes[0].id);
    expect(after.notes).toHaveLength(1);
    expect(Number(after.notes[0].amount)).toBe(40);
    expect(after.stock).toBe(4);
    expect(transactions).toBe(1);
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoices[0].id } }),
    ).toMatchObject({
      status: "VOID",
    });
  }, 60_000);

  it("A2: the source line rebuilt right after the capture (order line kept): REFUNDED, the note stands", async () => {
    const s = await sale("a2");
    afterFirstTransaction = rotate(s);

    const out = await settle(capture(s));

    expect(out.ok).toBe(true);
    const after = await state(s);
    expect(after.returns[0].status).toBe("REFUNDED");
    expect(after.notes).toHaveLength(1);
    expect(after.stock).toBe(4);
  }, 60_000);

  it("A3: the rebuild that also loses the order line, right after the capture: still REFUNDED (no 409 for an existing return)", async () => {
    const s = await sale("a3");
    afterFirstTransaction = rotate(s, { dropOrderLine: true });

    const out = await settle(capture(s));

    expect(out.ok).toBe(true);
    const after = await state(s);
    expect(after.returns).toHaveLength(1);
    expect(after.returns[0].status).toBe("REFUNDED");
    expect(after.notes).toHaveLength(1);
  }, 60_000);

  it("B1: a void landing after the pricing read, before the invoice locks: 409 RETURN_NOTHING_BILLED, NOTHING written", async () => {
    const s = await sale("b1");
    afterTxPricing = voidInvoice(s);

    const out = await settle(capture(s));

    expect(out.ok).toBe(false);
    expect((out as any).e?.getStatus?.()).toBe(409);
    // the capture variant: nothing exists to cancel, so the code and words are not the approve / store-credit ones
    expect(codeOf((out as any).e)).toBe("RETURN_CAPTURE_SOURCE_CLOSED");
    expect((out as any).e?.getResponse?.().message).not.toMatch(/cancel|reject/i);
    const after = await state(s);
    expect(after.returns).toHaveLength(0);
    expect(after.notes).toHaveLength(0);
    expect(after.stock).toBe(0);
    expect(await prisma.orderCreditNote.count({ where: { tenantId: s.tenantId } })).toBe(0);
  }, 60_000);

  it("B2: a rebuild (order line kept) landing there: re-resolved through the order line, capture and credit succeed", async () => {
    const s = await sale("b2");
    afterTxPricing = rotate(s);

    const out = await settle(capture(s));

    expect(out.ok).toBe(true);
    const after = await state(s);
    expect(after.returns[0].status).toBe("REFUNDED");
    expect(after.notes).toHaveLength(1);
    expect(Number(after.notes[0].amount)).toBe(40);
  }, 60_000);

  it("C: the mint failing rolls the WHOLE capture back; the same-key retry mints exactly once", async () => {
    const s = await sale("c");
    const key = `r347-${RUN}-c`;
    const real = creditNotes.mintStandaloneInTx.bind(creditNotes);
    let armed = true;
    creditNotes.mintStandaloneInTx = async (...a: any[]) => {
      if (armed) {
        armed = false;
        throw new Error("mint exploded");
      }
      return real(...a);
    };
    try {
      const first = await settle(capture(s, { key }));
      expect(first.ok).toBe(false);
      const mid = await state(s);
      expect(mid.returns).toHaveLength(0);
      expect(mid.notes).toHaveLength(0);
      expect(mid.stock).toBe(0);

      const retry = await settle(capture(s, { key }));
      expect(retry.ok).toBe(true);
      const after = await state(s);
      expect(after.returns).toHaveLength(1);
      expect(after.returns[0].status).toBe("REFUNDED");
      expect(after.notes).toHaveLength(1);
      expect(after.stock).toBe(4);
    } finally {
      creditNotes.mintStandaloneInTx = real;
    }
  }, 60_000);

  it("D: a same-key replay of a finished capture returns the existing credit note, never a second one", async () => {
    const s = await sale("d");
    const key = `r347-${RUN}-d`;
    const first = await settle(capture(s, { key }));
    expect(first.ok).toBe(true);
    const again = await settle(capture(s, { key }));
    expect(again.ok).toBe(true);
    expect((again as any).v.creditNoteId).toBe((first as any).v.creditNoteId);
    const after = await state(s);
    expect(after.returns).toHaveLength(1);
    expect(after.notes).toHaveLength(1);
    expect(after.stock).toBe(4);
  }, 60_000);

  it("E1: a REFUND-resolution capture stores its intent and mints nothing", async () => {
    const s = await sale("e1");
    const out = await settle(capture(s, { resolution: "REFUND" }));
    expect(out.ok).toBe(true);
    const after = await state(s);
    expect(after.returns).toHaveLength(1);
    expect(after.returns[0].status).toBe("RECEIVED");
    expect(after.returns[0].refundMethod).toBe("EXTERNAL_REFUND");
    expect(after.returns[0].creditNoteId).toBeNull();
    expect(after.notes).toHaveLength(0);
    expect(after.stock).toBe(4);
  }, 60_000);
});
