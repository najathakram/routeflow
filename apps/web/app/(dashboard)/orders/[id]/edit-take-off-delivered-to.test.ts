/**
 * SA-1533 (s): the take-off of a delivered line the server said an admin may correct (`lineEditMode: "CORRECT"`) carries
 * `deliveredTo: 0`, on both ways the screen takes a line off: the CANCEL the per-line diff builds and the queued DELETE
 * the trash button leaves. Every other line stays a bare CANCEL / DELETE (the server keeps master's removal 409).
 */
import {
  buildEditItemFromLine,
  buildItemUpdates,
  type EditItemState,
} from "./_components/order-line-edit";
import type { OrderItem } from "@/lib/api/orders";

const line = (id: string, extra: Partial<OrderItem> = {}): OrderItem =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name: id, unit: "Box", unitsPerBox: null },
    qty: 10,
    deliveredQty: 10,
    unitPrice: 5,
    status: "PENDING",
    ...extra,
  }) as OrderItem;

const cancelled = (l: OrderItem): EditItemState => ({
  ...buildEditItemFromLine(l),
  cancelled: true,
});

describe("the CANCEL a take-off builds (SA-1533 (s))", () => {
  it("a CORRECT line is CANCEL with deliveredTo 0", () => {
    const base = [line("a", { lineEditMode: "CORRECT" } as Partial<OrderItem>)];
    expect(buildItemUpdates([cancelled(base[0])], base)).toEqual([
      { id: "a", action: "CANCEL", deliveredTo: 0 },
    ]);
  });

  it("an ordinary line stays a bare CANCEL", () => {
    const base = [line("b", { deliveredQty: 0 })];
    expect(buildItemUpdates([cancelled(base[0])], base)).toEqual([{ id: "b", action: "CANCEL" }]);
  });
});
