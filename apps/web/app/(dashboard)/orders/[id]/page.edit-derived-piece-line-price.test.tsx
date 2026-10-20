/**
 * Row 630: on Edit Items a derived Piece of an EXISTING pack line is priced from the line's OWN price and size, never from
 * the customer's live layered pack price. A line sold at 12 per box at $12.00 a box ($1.00 a piece) stays $1.00 a piece when
 * the customer's layer has since moved to $18 and the product was repacked: the server re-splits at the line's own size and
 * price, so the preview must read what the bill will. A fresh line still takes the live layer price.
 * Harness: page.price-layer-picker.test.tsx.
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

// the customer's live layered pack price, now $18 (the line was sold at $12.00 a box)
const LIVE_LAYER = [
  { ref: "pack", label: null, price: 18, listPrice: 12, source: "customer", aboveList: true },
] as never;
// a layer with a row for the Case only: no pack row, so the Piece is not layered at all
const CASE_ONLY_LAYER = [
  { ref: "u1", label: "Case", price: 6800, listPrice: 7680, source: "customer", aboveList: false },
] as never;

/** A stored boxed line: 30 pcs = 2 boxes + 6 pcs at a 12-per-box snapshot, $12 a box = $30.00. */
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

/** A line added this session (nothing stored yet): the live layer price is what it is sold at. */
const freshLine = (): EditItemState => ({
  id: "new-1",
  isNew: true,
  originalProductId: "p-1",
  originalProductName: "Widget",
  originalQty: 1,
  productId: "p-1",
  productName: "Widget",
  qty: 1,
  unitPrice: 18,
  basePrice: 12,
  originalUnitPrice: 18,
  cancelled: false,
  unit: "Box",
  unitsPerBox: 12,
  packUnit: "Box",
  packUnitsPerBox: 12,
  boxSplit: false,
  priceType: "STANDARD",
});

function Harness({
  seed,
  layer,
  capture,
}: {
  seed: EditItemState;
  layer?: never;
  capture: (i: EditItemState[]) => void;
}) {
  const [items, setItems] = React.useState<EditItemState[]>([seed]);
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
      layerOf={layer ? () => layer : undefined}
      pricingReady
    />
  );
}

const picker = () => screen.getByRole("combobox", { name: /Sell Widget by/i }) as HTMLSelectElement;
const pieceOptionText = () =>
  Array.from(picker().options).find((o) => o.value === "Piece")?.textContent ?? "";

function pickPieceAndType30(seed: EditItemState, layer?: never) {
  let latest: EditItemState[] = [];
  renderWithProviders(<Harness seed={seed} layer={layer} capture={(i) => (latest = i)} />);
  fireEvent.change(picker(), { target: { value: "Piece" } });
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
  return latest;
}

describe("row 630: a derived Piece of an existing line keeps the line's own price and size", () => {
  it.each([
    ["product repacked smaller (12 -> 6)", 6],
    ["product repacked larger (12 -> 24)", 24],
    ["pack size unchanged (12), only the live layer moved", 12],
  ])("%s: the dropdown reads $1.00 a piece, not the live layer's share", (_n, live) => {
    renderWithProviders(
      <Harness
        seed={buildEditItemFromLine(storedLine(live))}
        layer={LIVE_LAYER}
        capture={() => {}}
      />,
    );
    expect(pieceOptionText()).toContain("$1.00");
    expect(pieceOptionText()).not.toContain("1.50");
    expect(pieceOptionText()).not.toContain("3.00");
  });

  it.each([6, 24, 12])(
    "live product %i: picking Piece sends the line's own $12.00 a box at 12 per box, 30 pcs = $30.00",
    (live) => {
      const line = storedLine(live);
      const latest = pickPieceAndType30(buildEditItemFromLine(line), LIVE_LAYER);
      const edited = latest[0]!;
      expect(edited.derivedBase).toBe("Piece");
      expect(edited.unitPrice).toBe(12);
      expect(edited.unitsPerBox).toBe(12);
      expect(screen.getByText("$30.00")).toBeInTheDocument();
      // 30 pcs at the same size and price as stored: nothing to save
      expect(buildItemUpdates(latest, [line])).toEqual([]);
    },
  );

  it("no layer price (flag off): master's Piece, byte for byte", () => {
    const latest = pickPieceAndType30(buildEditItemFromLine(storedLine(12)));
    expect(latest[0]!.unitPrice).toBe(12);
    expect(latest[0]!.unitsPerBox).toBe(12);
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });

  it("a layer with no pack row prices the Piece as master does", () => {
    const latest = pickPieceAndType30(buildEditItemFromLine(storedLine(12)), CASE_ONLY_LAYER);
    expect(latest[0]!.unitPrice).toBe(12);
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });

  it.each([6, 24])(
    "flag off, live product %i: the Piece still keeps the line's own $12.00 at 12 per box, 30 pcs = $30.00",
    (live) => {
      const line = storedLine(live);
      const latest = pickPieceAndType30(buildEditItemFromLine(line));
      expect(latest[0]!.unitPrice).toBe(12);
      expect(latest[0]!.unitsPerBox).toBe(12);
      expect(screen.getByText("$30.00")).toBeInTheDocument();
      expect(buildItemUpdates(latest, [line])).toEqual([]);
    },
  );

  it.each([6, 24])(
    "a layer with no pack row, live product %i: the Piece keeps the line's own price and size",
    (live) => {
      const line = storedLine(live);
      const latest = pickPieceAndType30(buildEditItemFromLine(line), CASE_ONLY_LAYER);
      expect(latest[0]!.unitPrice).toBe(12);
      expect(latest[0]!.unitsPerBox).toBe(12);
      expect(screen.getByText("$30.00")).toBeInTheDocument();
      expect(buildItemUpdates(latest, [line])).toEqual([]);
    },
  );

  it.each([
    ["flag off", undefined],
    ["layered", LIVE_LAYER],
  ])(
    "%s: a SPECIAL line stored at $10 (list $12) stays $10, never repriced up to list",
    (_n, layer) => {
      const line = {
        ...(storedLine(12) as object),
        unitPrice: 10,
        originalPrice: 12,
        priceType: "SPECIAL",
        subtotal: 25,
      } as never;
      const latest = pickPieceAndType30(buildEditItemFromLine(line), layer as never);
      expect(latest[0]!.unitPrice).toBe(10);
      expect(latest[0]!.unitsPerBox).toBe(12);
      expect(screen.getByText("$25.00")).toBeInTheDocument();
      expect(buildItemUpdates(latest, [line])).toEqual([]);
    },
  );

  it("DECISION: a pack price typed this session is replaced by the STORED price when Piece is picked", () => {
    // the Piece is the line's stored price over its stored size, so the operator's unsaved $11 on the pack does not carry over
    const seed = { ...buildEditItemFromLine(storedLine(12)), unitPrice: 11, priceEdited: true };
    const latest = pickPieceAndType30(seed, LIVE_LAYER);
    expect(latest[0]!.unitPrice).toBe(12);
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });

  it("a FRESH line still takes the live layer price: $18 a box at 12 per box = $1.50 a piece", () => {
    let latest: EditItemState[] = [];
    renderWithProviders(
      <Harness seed={freshLine()} layer={LIVE_LAYER} capture={(i) => (latest = i)} />,
    );
    expect(pieceOptionText()).toContain("$1.50");
    fireEvent.change(picker(), { target: { value: "Piece" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
    expect(latest[0]!.unitPrice).toBe(18);
    expect(latest[0]!.unitsPerBox).toBe(12);
    expect(screen.getByText("$45.00")).toBeInTheDocument();
  });
});
