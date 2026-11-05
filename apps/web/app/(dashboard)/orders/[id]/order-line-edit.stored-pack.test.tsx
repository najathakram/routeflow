/**
 * SA-1097 A-2 at the editor: a stored box-split line with NO unitsPerBox snapshot loads at the pack it was SOLD in, never the
 * live product's. Rows A2-W1..A2-W4 (the web half of a2-delivered-line-live-pack.db.spec.ts: the same four lines, the web's
 * real payload builder). The line is 10 boxes at 10.00 (100.00); the product's pack is now 24.
 */
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { OrderItem } from "@/lib/api/orders";
import { lineDisplayPack, lineOwnPack } from "@/lib/line-own-pack";
import {
  EditableLineItems,
  buildEditItemFromLine,
  buildItemUpdates,
  editLineSubtotal,
  type EditItemState,
} from "./_components/order-line-edit";
import { findLockedUnitLineEdit, PACK_LOCKED_COPY } from "./_components/unit-line-lock";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

const NOW_PACK = 24;
const line = (over: Partial<OrderItem> = {}): OrderItem =>
  ({
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Acme cola", unit: "case", unitsPerBox: NOW_PACK },
    qty: 120,
    boxes: 10,
    pieces: 0,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 100,
    priceType: "STANDARD",
    ...over,
  }) as OrderItem;

/** Edit the loaded row's price to 12.00 and return what the web would preview and send. */
function editPrice(li: OrderItem, price = 12) {
  const loaded = buildEditItemFromLine(li);
  const edited: EditItemState = { ...loaded, unitPrice: price, priceEdited: true };
  return { loaded, preview: editLineSubtotal(edited), payload: buildItemUpdates([edited], [li]) };
}

describe("SA-1097 A-2 — the editor loads a stored line at the pack it was sold in", () => {
  it("A2-W1: the 12-pack line loads as 10 cases of 12, price to 12.00 previews 120.00 and sends {qty 120, boxes 10, pieces 0}", () => {
    const { loaded, preview, payload } = editPrice(line());
    expect(loaded.unitsPerBox).toBe(12);
    expect(loaded.originalUnitsPerBox).toBe(12);
    expect(loaded.boxSplit).toBe(true);
    expect(preview).toBe(120);
    expect(payload).toEqual([
      expect.objectContaining({
        id: "li-1",
        action: "UPDATE",
        qty: 120,
        boxes: 10,
        pieces: 0,
        unitPrice: 12,
      }),
    ]);
  });

  it("A2-W2: the no-pack line (10 boxes, qty 10) loads plain, price to 12.00 previews 120.00 and sends no split", () => {
    const { loaded, preview, payload } = editPrice(line({ qty: 10 }));
    expect(loaded.unitsPerBox).toBeNull();
    expect(loaded.boxSplit).toBe(false);
    expect(preview).toBe(120);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ id: "li-1", action: "UPDATE", qty: 10, unitPrice: 12 });
    expect(payload[0]).not.toHaveProperty("boxes");
    expect(payload[0]).not.toHaveProperty("pieces");
  });

  it("A2-W3: a line whose pack can't be read loads locked with the text; price and qty edits are refused, a note edit saves as a note only", () => {
    const li = line({ qty: 6, boxes: 0, pieces: 6, subtotal: 7 }); // 7.00 fits neither the 24-pack nor no pack
    expect(lineOwnPack(li).kind).toBe("unreadable");
    const loaded = buildEditItemFromLine(li);
    expect(loaded).toMatchObject({ countLocked: true, packLocked: true, lockedSubtotal: 7 });
    expect(editLineSubtotal(loaded)).toBe(7);

    const { container } = renderWithProviders(
      <EditableLineItems
        items={[loaded]}
        onChange={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        canEditPrice
        tierPriceFor={() => 10}
        isSpecialTierFor={() => false}
        tierForProductId={() => 1}
        pricingReady
      />,
    );
    expect(screen.getByText(PACK_LOCKED_COPY)).toBeInTheDocument();
    expect(container.querySelector('input[type="number"]')).toBeNull(); // no qty input
    expect(screen.queryByText(/discount/i)).toBeNull(); // no price row

    const priced = { ...loaded, unitPrice: 12 };
    expect(findLockedUnitLineEdit([priced], [li])).toBe(priced);
    expect(findLockedUnitLineEdit([{ ...loaded, qty: 5 }], [li])).toBeDefined();

    const noted = { ...loaded, notes: "left at the dock" };
    expect(findLockedUnitLineEdit([noted], [li])).toBeUndefined();
    expect(buildItemUpdates([noted], [li])).toEqual([
      { id: "li-1", action: "UPDATE", notes: "left at the dock" },
    ]);
  });

  it("A2-W4 (guard): a line WITH its snapshot (12) loads at it, unchanged, and sends the same split as before", () => {
    const li = line({ unitsPerBox: 12 });
    expect(lineOwnPack(li).kind).toBe("as-stored");
    const { loaded, preview, payload } = editPrice(li);
    expect(loaded.unitsPerBox).toBe(12);
    expect(preview).toBe(120);
    expect(payload[0]).toMatchObject({ qty: 120, boxes: 10, pieces: 0, unitPrice: 12 });
  });

  it("the display pack: a stored 12-pack line shows 12, a no-pack line none, a snapshot line its snapshot, a plain line the product's", () => {
    expect(lineDisplayPack(line())).toBe(12);
    expect(lineDisplayPack(line({ qty: 10 }))).toBeNull();
    expect(lineDisplayPack(line({ unitsPerBox: 6 }))).toBe(6);
    expect(lineDisplayPack(line({ boxes: null, pieces: null, qty: 4 }))).toBe(NOW_PACK);
  });
});
