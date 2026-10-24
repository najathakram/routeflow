/**
 * The items array the buyer portal order edit sends (PATCH /buyer/orders/:id/items): one entry per edit row, a stored
 * line named by its `orderItemId`, a row added this session carrying none. The API refuses an items array that names
 * one line twice (400 DUPLICATE_LINE_ID), so this builder maps rows 1:1 and never invents or repeats an id.
 */
export function buyerEditPayloadItems(
  rows: ReadonlyArray<{ productId: string; qty: number; orderItemId?: string | null }>,
): Array<{ productId: string; qty: number; orderItemId?: string }> {
  return rows.map((i) => ({
    productId: i.productId,
    qty: i.qty,
    ...(i.orderItemId ? { orderItemId: i.orderItemId } : {}),
  }));
}
