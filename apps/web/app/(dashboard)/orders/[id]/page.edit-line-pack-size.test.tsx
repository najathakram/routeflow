/**
 * Row 620: Edit Items seeds a legacy boxed line's pack size from the LINE's own sale-time snapshot, never the live product.
 * A line stored at 12 per box keeps 12 when the product is later repacked, so a Piece pick converts 30 pcs at the factor the
 * stored line was priced at (2 boxes + 6 pcs = $30.00), not at the repacked size. Harness: unit-picker-mount.test.tsx.
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import {
  EditableLineItems,
  buildEditItemFromLine,
  buildItemUpdates,
  type EditItemState,
} from "./page";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: [
      {
        id: "u1",
        label: "Case",
        factorToBase: 192,
        price: "7680.00",
        priceTier2: null,
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
        isDefaultSelling: false,
        sortOrder: 0,
      },
    ],
  }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

/** A stored legacy boxed line: 30 pcs = 2 boxes + 6 pcs at a 12-per-box snapshot, $12 a box = $30.00. */
function storedLine(liveUnitsPerBox: number) {
  return {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Widget", unit: "Box", unitsPerBox: liveUnitsPerBox },
    qty: 30,
    boxes: 2,
    pieces: 6,
    unitsPerBox: 12,
    unitPrice: 12,
    originalPrice: 12,
    subtotal: 30,
    priceType: "STANDARD",
    unitLabel: null,
    status: "PENDING",
  } as never;
}

function Harness({ line, capture }: { line: never; capture: (i: EditItemState[]) => void }) {
  const [items, setItems] = React.useState<EditItemState[]>([buildEditItemFromLine(line)]);
  return (
    <EditableLineItems
      items={items}
      onChange={(next) => {
        capture(next);
        setItems(next);
      }}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 12}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

function pickPieceAndType30(line: never) {
  let latest: EditItemState[] = [];
  renderWithProviders(<Harness line={line} capture={(i) => (latest = i)} />);
  fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
    target: { value: "Piece" },
  });
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
  return latest;
}

describe("row 620: Edit Items keeps a legacy boxed line's own pack size through a Piece pick", () => {
  it.each([
    ["product repacked smaller (12 -> 6)", 6],
    ["product repacked larger (12 -> 24)", 24],
  ])("%s: 30 pieces stay 30 pcs and $30.00 (2 boxes + 6 pcs at 12 per box)", (_name, live) => {
    const line = storedLine(live);
    const latest = pickPieceAndType30(line);
    const edited = latest[0]!;
    expect(edited.derivedBase).toBe("Piece");
    expect(edited.unitsPerBox).toBe(12);
    expect(screen.getByText("$30.00")).toBeInTheDocument();

    // Same 30 pcs at the same size: nothing to save (the bug sent qty 18 / 54 here).
    expect(buildItemUpdates(latest, [line])).toEqual([]);
  });

  it.each([6, 24])(
    "the seed keeps the line's own 12 per box when the live product is %i",
    (live) => {
      expect(buildEditItemFromLine(storedLine(live)).packUnitsPerBox).toBe(12);
    },
  );

  it("a line with no snapshot falls back to the live product size", () => {
    const line = { ...(storedLine(24) as object), unitsPerBox: null } as never;
    expect(buildEditItemFromLine(line).packUnitsPerBox).toBe(24);
  });
});
