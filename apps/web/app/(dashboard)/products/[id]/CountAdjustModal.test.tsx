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
const setup = (p = product) => render(<CountAdjustModal product={p} onClose={jest.fn()} />);
/** One quantity box per unit the product offers, found by its unit word. */
const row = (unit: string) => screen.getByLabelText(new RegExp(`^${unit}\\b`));
const type = (unit: string, v: string) => fireEvent.change(row(unit), { target: { value: v } });
const save = () => screen.getByRole("button", { name: /^save$/i });
const reason = (v: string) =>
  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: v } });
const preview = () => screen.getByTestId("count-preview");

beforeEach(() => {
  mockMutate.mockClear();
  mockLadder.current = TWO_UNITS;
});

describe("CountAdjustModal (SA-957 M1 / SA-958: one quantity row per unit)", () => {
  it("shows a row for every unit the product offers and no unit picker", () => {
    setup();
    expect(row("Case")).toBeInTheDocument();
    expect(row("Piece")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unit")).toBeNull();
  });

  it('SET "3 Case" posts one part and previews 36 Pieces', () => {
    setup();
    type("Case", "3");
    expect(preview()).toHaveTextContent("Stock will be 36 Pieces (was 10)");
    expect(save()).toBeDisabled();
    reason("COUNT_CORRECTION");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0]).toEqual({
      mode: "SET",
      parts: [{ unit: null, quantity: 3 }],
      reason: "COUNT_CORRECTION",
    });
  });

  it("SA-957 red row: 3 in the Case row and 4 in the Piece row sends TWO parts (at the head there is no second box)", () => {
    mockLadder.current = [
      { id: "u1", label: "Case", factorToBase: 24 },
      { id: "u2", label: "Box", factorToBase: 12 },
    ];
    setup({ ...product, unit: "Piece", unitsPerBox: 1 });
    type("Case", "3");
    type("Box", "4");
    expect(preview()).toHaveTextContent("3 Case (×24) + 4 Box (×12) = 120 Pieces");
    expect(preview()).toHaveTextContent("Stock will be 120 Pieces (was 10)");
    reason("COUNT_CORRECTION");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0].parts).toEqual([
      { unit: "Case", quantity: 3 },
      { unit: "Box", quantity: 4 },
    ]);
  });

  it("a blank row is not sent", () => {
    setup();
    type("Case", "2");
    type("Piece", "");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0].parts).toEqual([{ unit: null, quantity: 2 }]);
  });

  it("a fractional Case is refused under its own row and blocks Save; a fractional Piece is fine", () => {
    setup();
    type("Case", "1.5");
    reason("DAMAGED");
    const problem = screen.getByTestId("count-row-error-Case");
    expect(problem).toHaveTextContent("Count whole cases, or count the rest in pieces.");
    expect(row("Case")).toHaveAttribute("aria-describedby", expect.stringContaining(problem.id));
    expect(save()).toBeDisabled();
    type("Case", "");
    type("Piece", "2.5");
    expect(screen.queryByTestId("count-row-error-Case")).toBeNull();
    expect(save()).toBeEnabled();
  });

  it("ADJUST has a labelled Add | Remove control (no flipping +/- button) and one sign for the delta", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: "Adjust" }));
    expect(screen.queryByLabelText(/adding stock|removing stock/i)).toBeNull();
    const group = screen.getByRole("radiogroup", { name: "Add or remove" });
    expect(group).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Remove" }));
    type("Case", "1");
    expect(preview()).toHaveTextContent("Stock will be 10 − 12 = −2 Pieces");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0]).toEqual({
      mode: "ADJUST",
      parts: [{ unit: null, quantity: 1 }],
      sign: "-",
      reason: "DAMAGED",
    });
    fireEvent.click(screen.getByRole("radio", { name: "Add" }));
    expect(preview()).toHaveTextContent("Stock will be 10 + 12 = 22 Pieces");
  });

  it("SA-958 red row: 40 on hand, Remove 48 shows the amber line and Save stays enabled", () => {
    mockLadder.current = undefined;
    setup({ ...product, unit: "Piece", unitsPerBox: 1, currentStock: 40 });
    fireEvent.click(screen.getByRole("radio", { name: "Adjust" }));
    fireEvent.click(screen.getByRole("radio", { name: "Remove" }));
    type("Piece", "48");
    reason("COUNT_CORRECTION");
    expect(screen.getByTestId("count-below-zero")).toHaveTextContent(
      "This takes stock below zero (−8 Pieces).",
    );
    expect(save()).toBeEnabled();
    type("Piece", "40");
    expect(screen.queryByTestId("count-below-zero")).toBeNull();
  });

  it("an ADJUST with every row blank or zero cannot be saved", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: "Adjust" }));
    reason("DAMAGED");
    expect(save()).toBeDisabled();
    type("Case", "0");
    expect(save()).toBeDisabled();
    type("Piece", "1");
    expect(save()).toBeEnabled();
  });

  it("a SET of zero is a real count", () => {
    setup();
    type("Case", "0");
    reason("THEFT");
    fireEvent.click(save());
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ mode: "SET", parts: [{ quantity: 0 }] });
  });

  it("puts each requirement under its own field once something is typed", () => {
    setup();
    expect(screen.queryByTestId("count-reason-hint")).toBeNull();
    type("Case", "2");
    const reasonField = screen.getByLabelText(/reason/i);
    expect(screen.getByTestId("count-reason-hint")).toHaveTextContent("Pick a reason.");
    expect(reasonField).toHaveAttribute("aria-describedby", "count-reason-hint");
    expect(screen.queryByTestId("count-save-hint")).toBeNull();
    reason("OTHER");
    expect(screen.queryByTestId("count-reason-hint")).toBeNull();
    expect(screen.getByTestId("count-note-hint")).toHaveTextContent("Add a note for Other.");
    expect(screen.getByLabelText(/note/i)).toHaveAttribute("aria-describedby", "count-note-hint");
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "dropped" } });
    expect(screen.queryByTestId("count-note-hint")).toBeNull();
    expect(save()).toBeEnabled();
  });

  it("a loose product reads in its own word, pluralised (10 bags, never pcs)", () => {
    mockLadder.current = undefined;
    setup({ id: "p2", name: "Loose", unit: "bag", unitsPerBox: 1, currentStock: 4 });
    type("bag", "10");
    expect(preview()).toHaveTextContent("Stock will be 10 bags (was 4)");
    expect(document.body.textContent).not.toMatch(/\bpcs\b/);
  });

  it("anchors the dialog at the top so Save and Cancel do not jump as rows appear", () => {
    expect(readFileSync(resolve(__dirname, "CountAdjustModal.tsx"), "utf8")).toMatch(
      /<Modal[^>]*anchor="top"/,
    );
  });

  it("scrolls inside the dialog, so Save stays reachable on a short screen (3 rows + note + date at 390 px)", () => {
    expect(readFileSync(resolve(__dirname, "CountAdjustModal.tsx"), "utf8")).toMatch(
      /<Modal[^>]*\bscroll\b/,
    );
  });

  it("Save and Cancel sit in the dialog's pinned footer, outside the scrolling form, and still submit it", () => {
    setup();
    expect(save().closest("form")).toBeNull();
    expect(save()).toHaveAttribute("form", "count-form");
    type("Case", "2");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("every control is at least 44 px tall below sm", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: "Adjust" }));
    const tall = (el: HTMLElement) => expect(el.className).toMatch(/min-h-\[44px\]/);
    tall(row("Case"));
    tall(row("Piece"));
    tall(screen.getByLabelText(/reason/i));
    tall(screen.getByRole("radio", { name: "Adjust" }));
    tall(screen.getByRole("radio", { name: "Remove" }));
    tall(save());
    tall(screen.getByRole("button", { name: /^close$/i }));
    tall(screen.getByRole("button", { name: /^cancel$/i }));
  });

  it("Other without a note blocks Save", () => {
    setup();
    type("Case", "2");
    reason("OTHER");
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "dropped" } });
    expect(save()).toBeEnabled();
  });

  it("scrolls a server refusal into view (the body scrolls under a pinned footer on a short screen)", () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockMutate.mockImplementation((_b, opts) =>
      opts.onError({ response: { status: 409, data: { code: "STOCK_DATE_IN_FILED_PERIOD" } } }),
    );
    setup();
    type("Case", "2");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    mockMutate.mockReset();
  });

  it("says what is filed, through the code's own message, for a filed-period 409", () => {
    mockMutate.mockImplementation((_b, opts) =>
      opts.onError({
        response: {
          status: 409,
          data: { code: "STOCK_DATE_IN_FILED_PERIOD", filedFor: "Tobacco", period: "Sep 2026" },
        },
      }),
    );
    setup();
    type("Case", "2");
    reason("DAMAGED");
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sep 2026 is already filed for Tobacco, so stock can't be dated on or before it. Choose a later date.",
    );
    mockMutate.mockReset();
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
