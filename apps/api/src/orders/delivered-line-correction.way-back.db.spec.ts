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
import { LOCKED_COPY } from "./delivered-line-copy";

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
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 180_000);

  // SA-1546 10.2: the producer's shape. A no-row line bills its full qty, so the sibling (delivered 6 of 10, no rows) is
  // invoiced at 10 (invoicedQty 10, invoice line 10): nothing is partly invoiced, the correction of B1 is accepted, and
  // the way back lifts the sibling column 6 to 10 with no new row and no stock movement.
  it("(aw) producer-shape sibling: a no-row 6/10 line invoiced at 10 beside B1 10/10 -> 8: the correction is accepted and the way back writes no row and moves no stock", async () => {
    const { order, items, lines, inv } = await deliveredAndBilled("aws", [10, 10]);
    await w.prisma.orderItem.update({ where: { id: items[1].id }, data: { deliveredQty: 6 } });
    await status(order.id, "CONFIRMED", "office correction");
    await edit(order.id, [{ id: items[0].id, qty: 8 }]);
    const invAfterCut = await w.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const rowsAfterCut = await w.prisma.deliveryMutation.count({ where: { orderId: order.id } });
    const movesAfterCut = [
      await stockRows(lines[0].productId),
      await stockRows(lines[1].productId),
    ];
    const a = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect([Number(a.qty), Number(a.deliveredQty)]).toEqual([8, 8]);

    await status(order.id, "OUT_FOR_DELIVERY");
    await status(order.id, "DELIVERED");

    const b = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[1].id } });
    expect([Number(b.qty), Number(b.deliveredQty)]).toEqual([10, 10]); // the stamp lifts the sibling 6 to 10
    expect(await w.prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(
      rowsAfterCut,
    );
    expect([await stockRows(lines[0].productId), await stockRows(lines[1].productId)]).toEqual(
      movesAfterCut,
    );
    expect(await w.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
    const invAfterWayBack = await w.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([invAfterWayBack.status, Number(invAfterWayBack.total)]).toEqual([
      invAfterCut.status,
      Number(invAfterCut.total),
    ]);
    await expectLedgerConsistent(
      w.tenantId,
      lines.map((l) => l.productId),
    );
  }, 180_000);

  // Fixture-built (hand-written invoicedQty 6 and an invoice line of 6: no named writer produces it). The order is partly
  // invoiced, so 9.2's row applies: LOCKED SPLIT_BILL, the correction is refused with its sentence, nothing written. The
  // way back on such an order is master's code (ORDER_INVOICE_SETTLE_FAILED, SA-1546 10.2) and is not asserted here.
  it("(aw) fixture-built: a no-row 6/10 sibling invoiced at 6 makes the order partly invoiced: the correction of B1 is LOCKED SPLIT_BILL, 0 writes", async () => {
    const { order, items, inv } = await deliveredAndBilled("awf", [10, 10]);
    await w.prisma.orderItem.update({
      where: { id: items[1].id },
      data: { deliveredQty: 6, invoicedQty: 6 } as any,
    });
    await w.prisma.invoiceItem.updateMany({
      where: { invoiceId: inv.id, orderItemId: items[1].id },
      data: { qty: 6, subtotal: 30 },
    });
    await w.prisma.invoice.update({ where: { id: inv.id }, data: { subtotal: 80, total: 80 } });
    await status(order.id, "CONFIRMED", "office correction");
    await expect(edit(order.id, [{ id: items[0].id, qty: 8 }])).rejects.toMatchObject({
      status: 409,
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining(LOCKED_COPY.SPLIT_BILL),
      },
    });
    const a = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect([Number(a.qty), Number(a.deliveredQty)]).toEqual([10, 10]);
    const invoice = await w.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([invoice.status, Number(invoice.total)]).toEqual(["SENT", 80]);
  }, 180_000);
});
