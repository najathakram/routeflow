/**
 * O1 (F06, apple-ux run 2026-10-16): Edit Items gave a boxed line one bare Qty box (total PIECES),
 * so "3 cases + 4 loose" could not be entered. A classic boxed line now gets the SAME shared
 * cases + loose-pieces control Create uses (CasesPiecesInput), normalised through
 * @routeflow/pricing normalizeBoxesPieces; the save payload carries boxes/pieces and the row total
 * is computeLineSubtotal's, never qty * unitPrice.
 */
import * as React from "react";
import { computeLineSubtotal } from "@routeflow/pricing";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { EditableLineItems, buildItemUpdates, type EditItemState } from "./page";

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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const CASE_PRICE = 24;
const UPB = 12;

const boxedLine = (over: Partial<EditItemState> = {}): EditItemState => ({
  id: "li-1",
  originalProductId: "p-1",
  originalProductName: "Sample Chips",
  originalQty: 2 * UPB,
  productId: "p-1",
  productName: "Sample Chips",
  qty: 2 * UPB, // total PIECES for a stored box/piece split
  unitPrice: CASE_PRICE,
  basePrice: CASE_PRICE,
  originalUnitPrice: CASE_PRICE,
  cancelled: false,
  unit: "case",
  unitsPerBox: UPB,
  boxSplit: true,
  priceType: "STANDARD",
  ...over,
});

const original = (qty: number, over: Record<string, unknown> = {}) =>
  [
    {
      id: "li-1",
      productId: "p-1",
      qty,
      unitPrice: CASE_PRICE,
      boxes: 2,
      pieces: 0,
      ...over,
    },
  ] as never;

let latest: EditItemState[] = [];
function Harness({ initial }: { initial: EditItemState[] }) {
  const [items, setItems] = React.useState(initial);
  latest = items;
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => CASE_PRICE}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

const cases = () => screen.getByTitle(/number of whole/i) as HTMLInputElement;
const loose = () => screen.getByLabelText(/^extra /i) as HTMLInputElement;

describe("Edit Items: shared cases + loose-pieces control (O1 / F06)", () => {
  it("a boxed line shows cases (not a bare Qty of pieces) with a '+ units' toggle", () => {
    renderWithProviders(<Harness initial={[boxedLine()]} />);
    expect(cases().value).toBe("2");
    expect(screen.queryByRole("spinbutton", { name: /^qty$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /add extra/i })).toBeInTheDocument();
  });

  it("2 cases + 5 loose sends boxes 2 / pieces 5 and the row total is the boxed proration, not qty x price", () => {
    renderWithProviders(<Harness initial={[boxedLine()]} />);
    fireEvent.click(screen.getByRole("button", { name: /add extra/i }));
    fireEvent.change(loose(), { target: { value: "5" } });
    expect(latest[0].qty).toBe(29);
    expect(latest[0].boxSplit).toBe(true);
    const sent = buildItemUpdates(latest, original(2 * UPB));
    expect(sent).toEqual([expect.objectContaining({ id: "li-1", qty: 29, boxes: 2, pieces: 5 })]);
    const expected = computeLineSubtotal({
      unitPrice: CASE_PRICE,
      qty: 29,
      boxes: 2,
      pieces: 5,
      unitsPerBox: UPB,
    });
    expect(expected).toBeCloseTo(CASE_PRICE * (2 + 5 / UPB), 2); // 58.00
    // RED on the old value: qty x unitPrice would be 29 x 24 = 696.00
    expect(screen.getByText(/58\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/696\.00/)).toBeNull();
  });

  it("0 cases + 14 loose normalizes to 1 case + 2 loose", () => {
    // A line of 0 cases + 5 loose pieces (qty 5 pieces); the loose field is already open.
    renderWithProviders(<Harness initial={[boxedLine({ qty: 5, originalQty: 5 })]} />);
    expect(cases().value).toBe("0");
    expect(loose().value).toBe("5");
    fireEvent.change(loose(), { target: { value: "14" } });
    expect(latest[0].qty).toBe(14);
    expect(cases().value).toBe("1");
    expect(loose().value).toBe("2");
    expect(buildItemUpdates(latest, original(5, { boxes: 0, pieces: 5 }))).toEqual([
      expect.objectContaining({ boxes: 1, pieces: 2 }),
    ]);
  });

  it("clearing the only quantity to 0 is ignored (an order line never holds nothing)", () => {
    renderWithProviders(<Harness initial={[boxedLine({ qty: UPB, originalQty: UPB })]} />);
    fireEvent.change(cases(), { target: { value: "0" } });
    expect(latest[0].qty).toBe(UPB);
    expect(cases().value).toBe("1");
  });

  it("a boxed line stored WITHOUT a split (qty in cases) converts to pieces on first edit", () => {
    renderWithProviders(
      <Harness initial={[boxedLine({ qty: 3, originalQty: 3, boxSplit: false })]} />,
    );
    expect(cases().value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: /add extra/i }));
    fireEvent.change(loose(), { target: { value: "4" } });
    expect(latest[0].qty).toBe(3 * UPB + 4);
    expect(latest[0].boxSplit).toBe(true);
    expect(buildItemUpdates(latest, original(3, { boxes: null, pieces: null }))).toEqual([
      expect.objectContaining({ boxes: 3, pieces: 4 }),
    ]);
  });

  it("an unboxed line keeps the plain Qty input", () => {
    renderWithProviders(
      <Harness
        initial={[boxedLine({ unitsPerBox: null, boxSplit: false, qty: 5, originalQty: 5 })]}
      />,
    );
    expect(screen.queryByTitle(/number of whole/i)).toBeNull();
    expect(screen.getByRole("spinbutton", { name: /qty/i })).toHaveValue(5);
  });

  it("a units_v1 unit line shows no cases input (its count input is unchanged)", () => {
    renderWithProviders(
      <Harness initial={[boxedLine({ unitLabel: "Case", boxSplit: false, qty: 3 })]} />,
    );
    expect(screen.queryByTitle(/number of whole/i)).toBeNull();
  });

  it("a cancelled line shows no quantity control at all", () => {
    renderWithProviders(<Harness initial={[boxedLine({ cancelled: true })]} />);
    expect(screen.queryByTitle(/number of whole/i)).toBeNull();
    const row = screen.getByText("Sample Chips").closest("div[class*='rounded-lg']") as HTMLElement;
    expect(within(row).queryByRole("spinbutton", { name: /qty/i })).toBeNull();
  });
});
