/**
 * SA-1544 (aw), real Postgres, REAL invoices: the way back after a correction. A delivered line (B1 10/10) is reopened by the
 * real status change, corrected to 8 by an admin on a SENT invoice, then walked back CONFIRMED -> OUT_FOR_DELIVERY ->
 * DELIVERED with the real status changes. The corrected line owes nothing more: deliveredQty stays 8, qty stays 8, no
 * delivery row is written on it, no stock moves, and the invoice keeps the total and status the correction left.
 *
 * The order-stock world (a real OrdersService over a real PrismaService); only its INVOICE stubs are lifted, so the edit
 * restates through the real `resyncOrderInvoicesForEdit` and the delivery settles through the real
 * `createInvoiceFromOrderWithTenant`. The invoice itself is seeded raw (the world's DELIVERED makes none while stubbed).
 *
 * Test tenant only (qa-sa1506w-*, assertTestTenant in the world). Run: `npm run local:test:db`.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

const STUB_KEYS = [
  "revertLinkedInvoicesForOrderEdit",
  "resyncOrderInvoicesForEdit",
  "reconcileOrderDraftInvoice",
  "findOpenOrderDraft",
  "createInvoiceFromOrderWithTenant",
  "projectEditedInvoiceTotals",
  "followPartialPrices",
] as const;

describeDb("SA-1544 (aw): the way back after a correction, real invoices", () => {
  let w: OrderStockWorld;
  const invoiceIds: string[] = [];
  const saved: Record<string, unknown> = {};
  const notified: string[] = [];

  beforeAll(async () => {
    w = await buildOrderStockWorld("sa1506w", "delivered-line-correction.way-back.db.spec.ts");
    const inv: any = (w.orders as any).invoicesService;
    for (const k of STUB_KEYS) saved[k] = inv[k];
    // every notification the status changes send is counted, never delivered
    const recorder = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then" || typeof prop === "symbol"
            ? undefined
            : async () => {
                notified.push(String(prop));
                return undefined;
              },
      },
    );
    (w.orders as any).notifications = recorder;
    (w.orders as any).messaging = recorder;
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    if (w) {
      await w.prisma.invoicePayment
        .deleteMany({ where: { invoiceId: { in: invoiceIds } } })
        .catch(swallow);
      await w.prisma.invoiceItem
        .deleteMany({ where: { invoiceId: { in: invoiceIds } } })
        .catch(swallow);
      await w.prisma.invoice.deleteMany({ where: { orderId: { in: w.orderIds } } }).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  const real = () => {
    const inv: any = (w.orders as any).invoicesService;
    for (const k of STUB_KEYS) delete inv[k];
    inv.authority = { can: async () => false };
  };
  const stubbed = () => Object.assign((w.orders as any).invoicesService, saved);

  const as = (role: string) => ({ ...w.jwt, role: role as any });
  const status = (id: string, to: string, reason?: string) =>
    w.inTenant(() =>
      w.orders.changeStatus(id, { status: to, ...(reason ? { reason } : {}) }, as("OPERATOR")),
    );
  const edit = (id: string, items: any[]) =>
    w.inTenant(() =>
      w.orders.updateOrderItems(id, { replaceAll: false, items }, as("TENANT_ADMIN")),
    );
  const observe = (text: string) =>
    require("fs").appendFileSync(
      "C:/ClaudeCode/wt/sa1506-pr1-logs/observe.txt",
      text + String.fromCharCode(10),
    );
  const stockRows = (p: string) => w.prisma.stockMovement.count({ where: { productId: p } });

  /** An order booked 10 x 5.00, marked DELIVERED while the invoice stubs are on, then billed raw on a SENT invoice. */
  async function deliveredAndBilled(tag: string, qtys: number[]) {
    stubbed();
    const lines: Array<{ productId: string; qty: number }> = [];
    for (const [i, q] of qtys.entries())
      lines.push({ productId: await w.product(`${tag}${i}`, q), qty: q });
    const { order, items } = await w.bookOrder({ status: "CONFIRMED", lines });
    const total = qtys.reduce((s, q) => s + q * 5, 0);
    await w.prisma.order.update({
      where: { id: order.id },
      data: { subtotal: total, total } as any,
    });
    await status(order.id, "DELIVERED");
    const inv = await w.prisma.invoice.create({
      data: {
        tenantId: w.tenantId,
        customerId: w.customerId,
        orderId: order.id,
        invoiceNumber: `INV-${tag}-${order.id.slice(0, 6)}`,
        status: "SENT",
        subtotal: total,
        total,
        items: {
          create: items.map((it, i) => ({
            tenantId: w.tenantId,
            orderItemId: it.id,
            productId: lines[i].productId,
            description: `line ${i}`,
            qty: qtys[i],
            unitPrice: 5,
            subtotal: qtys[i] * 5,
          })),
        } as any,
      },
    });
    invoiceIds.push(inv.id);
    await w.prisma.orderItem.updateMany({
      where: { orderId: order.id },
      data: { invoicedQty: 0 } as any,
    });
    for (const [i, it] of items.entries())
      await w.prisma.orderItem.update({
        where: { id: it.id },
        data: { invoicedQty: qtys[i] } as any,
      });
    real();
    return { order, items, lines, inv };
  }

  it("(aw) B1 10/10 corrected to 8 on a SENT invoice, then Out for delivery and Delivered: deliveredQty 8, qty 8, no new delivery row, no stock move, invoice total and status as the correction left them", async () => {
    const { order, items, lines, inv } = await deliveredAndBilled("aw", [10]);
    const p = lines[0].productId;
    await status(order.id, "CONFIRMED", "office correction: counted 8 on the truck");
    await edit(order.id, [{ id: items[0].id, qty: 8 }]);

    const lineAfterCut = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect([Number(lineAfterCut.qty), Number(lineAfterCut.deliveredQty)]).toEqual([8, 8]);
    const invAfterCut = await w.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([invAfterCut.status, Number(invAfterCut.total)]).toEqual(["SENT", 40]); // restated in place, status kept
    expect(await w.stockOf(p)).toBe(2);
    const rowsAfterCut = await w.prisma.deliveryMutation.count({
      where: { orderItemId: items[0].id },
    });
    const movesAfterCut = await stockRows(p);
    const notifiedBefore = notified.length;

    await status(order.id, "OUT_FOR_DELIVERY");
    await status(order.id, "DELIVERED");

    const line = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect([Number(line.qty), Number(line.deliveredQty)]).toEqual([8, 8]); // wrong value: 10 / 10 (the stamp lifted it back)
    expect(await w.prisma.deliveryMutation.count({ where: { orderItemId: items[0].id } })).toBe(
      rowsAfterCut,
    ); // wrong value: +1
    expect(await stockRows(p)).toBe(movesAfterCut); // wrong value: a movement per hop
    expect(await w.stockOf(p)).toBe(2);
    const invAfterWayBack = await w.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([invAfterWayBack.status, Number(invAfterWayBack.total)]).toEqual([
      invAfterCut.status,
      Number(invAfterCut.total),
    ]);
    expect(await w.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1); // nothing re-billed
    const itemQty = (await w.prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } })).reduce(
      (s, i) => s + Number(i.qty),
      0,
    );
    expect(itemQty).toBe(8);
    expect((await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "DELIVERED",
    );
    observe(
      "AW way back (B1 10/10 -> 8, SENT): invoice " +
        invAfterWayBack.status +
        " total=" +
        Number(invAfterWayBack.total) +
        " line invoicedQty=" +
        Number((line as any).invoicedQty) +
        " notifications on the way back=[" +
        notified.slice(notifiedBefore).join(",") +
        "]",
    );
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 180_000);

  it("(aw) OBSERVE: a sibling no-row 6/10 line beside the corrected line: what the way back completes and bills", async () => {
    const { order, items, lines, inv } = await deliveredAndBilled("aws", [10, 10]);
    // the sibling: delivered 6 of 10 with no evidence row, billed 6
    await w.prisma.orderItem.update({
      where: { id: items[1].id },
      data: { deliveredQty: 6, invoicedQty: 6 } as any,
    });
    await w.prisma.invoiceItem.updateMany({
      where: { invoiceId: inv.id, orderItemId: items[1].id },
      data: { qty: 6, subtotal: 30 },
    });
    await w.prisma.invoice.update({ where: { id: inv.id }, data: { subtotal: 80, total: 80 } });
    await w.prisma.order.update({
      where: { id: order.id },
      data: { subtotal: 100, total: 100 } as any,
    });
    await status(order.id, "CONFIRMED", "office correction");
    let outcome = "accepted";
    try {
      await edit(order.id, [{ id: items[0].id, qty: 8 }]);
    } catch (e: any) {
      outcome = "refused " + (e?.status ?? "") + " " + (e?.response?.code ?? e?.message);
    }
    let wayBack = "completed";
    try {
      await status(order.id, "OUT_FOR_DELIVERY");
      await status(order.id, "DELIVERED");
    } catch (e: any) {
      wayBack = "refused " + (e?.status ?? "") + " " + (e?.response?.code ?? e?.message);
    }
    const a = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    const b = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[1].id } });
    const invoices = await w.prisma.invoice.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
    });
    observe(
      "AW sibling no-row 6/10 beside B1 10/10 -> 8: correction " +
        outcome +
        "; way back " +
        wayBack +
        "; B1 qty/delivered=" +
        Number(a.qty) +
        "/" +
        Number(a.deliveredQty) +
        "; sibling qty/delivered=" +
        Number(b.qty) +
        "/" +
        Number(b.deliveredQty) +
        "; invoices=[" +
        invoices.map((i) => i.status + ":" + Number(i.total)).join(",") +
        "]",
    );
    expect(lines.length).toBe(2); // the fixture stood; the outcome is in observe.txt for the SA
  }, 180_000);
});
