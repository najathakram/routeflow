/**
 * SA-1546 M2: a quantity change of a delivered line the server said an admin may correct (`lineEditMode: "CORRECT"`) carries
 * `correctDelivered: true`, the opt-in the server needs before it restates the delivered figure. Only a changed quantity
 * carries it: a price-only edit names no quantity at all (a price is never a delivered statement), an ordinary line never
 * carries it, and a take-off keeps `deliveredTo: 0`.
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

const correct = (id = "a") => line(id, { lineEditMode: "CORRECT" } as Partial<OrderItem>);
const edited = (l: OrderItem, patch: Partial<EditItemState>): EditItemState => ({
  ...buildEditItemFromLine(l),
  ...patch,
});

describe("correctDelivered on the diff of a correctable line (SA-1546 M2)", () => {
  it("a changed quantity carries the flag", () => {
    const base = [correct()];
    expect(buildItemUpdates([edited(base[0], { qty: 8 })], base)).toEqual([
      expect.objectContaining({ id: "a", action: "UPDATE", qty: 8, correctDelivered: true }),
    ]);
  });

  it("a price-only edit names no quantity and carries no flag", () => {
    const base = [correct()];
    const [update] = buildItemUpdates([edited(base[0], { unitPrice: 6 })], base);
    expect(update).toMatchObject({ id: "a", action: "UPDATE", unitPrice: 6 });
    expect(update).not.toHaveProperty("qty");
    expect(update).not.toHaveProperty("boxes");
    expect(update).not.toHaveProperty("pieces");
    expect(update).not.toHaveProperty("correctDelivered");
  });

  it("a quantity and a price together carry the flag and both fields", () => {
    const base = [correct()];
    const [update] = buildItemUpdates([edited(base[0], { qty: 12, unitPrice: 6 })], base);
    expect(update).toMatchObject({ qty: 12, unitPrice: 6, correctDelivered: true });
  });

  it("an ordinary line never carries the flag, and keeps its qty on a price edit", () => {
    const base = [line("b", { deliveredQty: 0 })];
    const [cut] = buildItemUpdates([edited(base[0], { qty: 8 })], base);
    expect(cut).not.toHaveProperty("correctDelivered");
    const [price] = buildItemUpdates([edited(base[0], { unitPrice: 6 })], base);
    expect(price).toMatchObject({ qty: 10, unitPrice: 6 });
    expect(price).not.toHaveProperty("correctDelivered");
  });

  it("a take-off keeps deliveredTo 0 and carries no flag", () => {
    const base = [correct()];
    const [off] = buildItemUpdates([edited(base[0], { cancelled: true })], base);
    expect(off).toEqual({ id: "a", action: "CANCEL", deliveredTo: 0 });
  });
});
