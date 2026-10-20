import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CountAdjustModal } from "./CountAdjustModal";

const mockMutate = jest.fn();
const mockLadder: { current: { id: string; label: string; factorToBase: number }[] | undefined } = {
  current: undefined,
};
const TWO_UNITS = [
  { id: "u1", label: "Case", factorToBase: 12 },
  { id: "u2", label: "Piece", factorToBase: 1 },
];
jest.mock("@/lib/api/inventory", () => ({
  useProductCount: () => ({ mutate: mockMutate, isPending: false }),
}));
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({ data: mockLadder.current }),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const product = { id: "p1", name: "Widget", unit: "Case", unitsPerBox: 12, currentStock: 10 };
const setup = () => render(<CountAdjustModal product={product} onClose={jest.fn()} />);
const qty = () => screen.getByLabelText(/counted|amount/i);
const save = () => screen.getByRole("button", { name: /^save$/i });
const reason = (v: string) =>
  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: v } });

beforeEach(() => {
  mockMutate.mockClear();
  mockLadder.current = TWO_UNITS;
});

describe("CountAdjustModal", () => {
  it("SET 3 Case previews 36 pcs and posts the count", () => {
    setup();
    fireEvent.change(qty(), { target: { value: "3" } });
    expect(screen.getByTestId("count-preview")).toHaveTextContent("Stock will be 36 pcs (was 10)");
    expect(save()).toBeDisabled();
    reason("COUNT_CORRECTION");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0]).toEqual({
      mode: "SET",
      count: { unit: null, quantity: 3 },
      reason: "COUNT_CORRECTION",
    });
  });

  it("ADJUST minus 1 Case posts sign '-'", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: "Adjust" }));
    fireEvent.change(qty(), { target: { value: "1" } });
    expect(screen.getByTestId("count-preview")).toHaveTextContent("10 − 12 = −2 pcs");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0]).toEqual({
      mode: "ADJUST",
      delta: { unit: null, quantity: 1, sign: "-" },
      reason: "DAMAGED",
    });
  });

  it("a fractional Case blocks Save with the inline error", () => {
    setup();
    fireEvent.change(qty(), { target: { value: "1.5" } });
    reason("DAMAGED");
    expect(screen.getByRole("alert")).toHaveTextContent("Use a whole number, or switch to pcs.");
    expect(save()).toBeDisabled();
  });

  it("tells the user why Save is off once a quantity is typed", () => {
    setup();
    expect(screen.queryByTestId("count-save-hint")).toBeNull();
    fireEvent.change(qty(), { target: { value: "2" } });
    expect(screen.getByTestId("count-save-hint")).toHaveTextContent("Pick a reason.");
    reason("OTHER");
    expect(screen.getByTestId("count-save-hint")).toHaveTextContent("Add a note for Other.");
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "dropped" } });
    expect(screen.queryByTestId("count-save-hint")).toBeNull();
  });

  it("points the quantity at the preview and error lines", () => {
    setup();
    expect(qty()).toHaveAttribute("aria-describedby", "count-preview count-inline-error");
    fireEvent.change(qty(), { target: { value: "2" } });
    expect(document.getElementById("count-preview")).not.toBeNull();
  });

  it("Other without a note blocks Save", () => {
    setup();
    fireEvent.change(qty(), { target: { value: "2" } });
    reason("OTHER");
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "dropped" } });
    expect(save()).toBeEnabled();
  });

  it("shows the server message for a filed-period 409", () => {
    mockMutate.mockImplementation((_b, opts) =>
      opts.onError({
        response: {
          status: 409,
          data: { code: "STOCK_DATE_IN_FILED_PERIOD", message: "Q3 2026 is already filed." },
        },
      }),
    );
    setup();
    fireEvent.change(qty(), { target: { value: "2" } });
    reason("DAMAGED");
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("Q3 2026 is already filed.");
    mockMutate.mockReset();
  });
});

describe("single-unit product", () => {
  it("shows the unit as text, not a select", () => {
    mockLadder.current = undefined;
    render(
      <CountAdjustModal
        product={{ id: "p2", name: "Loose", unit: "kg", unitsPerBox: 1, currentStock: 4 }}
        onClose={jest.fn()}
      />,
    );
    expect(screen.queryByLabelText("Unit")).toBeNull();
  });
});

describe("Count / Adjust entry point", () => {
  const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
  it("shows on the card only when staff pass onCount, and the page gates it on staff and non-family", () => {
    const card = read("ProductStockCostCard.tsx");
    expect(card).toContain("{onCount && (");
    const page = read("page.tsx");
    expect(page).toContain("onCount={isStaff ? () => setShowCountModal(true) : undefined}");
    expect(page).toContain('product.kind !== "FAMILY" && (\n              <ProductStockCostCard');
  });
});
