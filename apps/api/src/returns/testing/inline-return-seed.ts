/**
 * SA-1101 A-6 (RO-31..RO-35) test seed: an INLINE return as capture leaves it, CARRIED by one order and SOLD on
 * another. `Return.orderId` is the carrying order (the credit lands on its invoice); each `ReturnItem.sourceOrderId`
 * is the order the goods were sold on. The guards that ask "does this order have a live return" must count the second
 * link too. Written straight to the tables: the guard reads rows, and the capture path that fills them (pinned or
 * priced from the matching set) is covered by the inline-return specs.
 */
export type InlineReturnSeedDb = {
  return: { create: (args: any) => Promise<{ id: string }> };
};

export async function seedInlineReturn(
  prisma: InlineReturnSeedDb,
  o: {
    tenantId: string;
    customerId: string;
    /** The order the return rides on (Return.orderId). */
    carryingOrderId: string;
    /** The order the goods were sold on (ReturnItem.sourceOrderId). */
    sourceOrderId: string;
    productId: string;
    qty?: number;
    /** A return held for approval: nothing restocked yet, it restocks on approval. */
    held?: boolean;
    /** A pinned line names the source order line; an unpinned one got its source from the pricer's matching set. */
    pinnedLineId?: string;
  },
): Promise<string> {
  const qty = o.qty ?? 4;
  const ret = await prisma.return.create({
    data: {
      orderId: o.carryingOrderId,
      customerId: o.customerId,
      reason: "EXCESS_ORDER",
      status: o.held ? "PENDING" : "RECEIVED",
      kind: "INLINE",
      ...(o.held ? { holdReason: "DRIVER_CAP", heldAmount: "40.00" } : {}),
      tenantId: o.tenantId,
      items: {
        create: [
          {
            productId: o.productId,
            qty: String(qty),
            restock: true,
            tenantId: o.tenantId,
            sourceOrderId: o.sourceOrderId,
            ...(o.pinnedLineId ? { sourceOrderItemId: o.pinnedLineId } : {}),
            unitPrice: "10.00",
            subtotal: String(qty * 10),
            taxAmount: "0.00",
            categoryTax: "0.00",
            pieces: qty,
            boxes: 0,
          },
        ],
      },
    },
  });
  return ret.id;
}
