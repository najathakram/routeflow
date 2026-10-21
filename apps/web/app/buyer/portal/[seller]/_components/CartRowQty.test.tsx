import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { setLineCount, setLineUnit, type CartLineShape } from "@/lib/buyer-cart-line";
import { CartRowQty } from "./CartRowQty";
import { CartLineUnit } from "./CartLineUnit";

/**
 * Row 531: the cart row's stepper counts the line's selling unit, names it, switches Case / Each,
 * and every target is 44px. State lives in the harness exactly as the cart hook keeps it: each
 * edit goes through `setLineCount` / `setLineUnit`, so a field cannot disagree with the line.
 */
function Harness({ start, onRemove = jest.fn() }: { start: CartLineShape; onRemove?: () => void }) {
  const [line, setLine] = React.useState(start);
  return (
    <CartRowQty
      item={line}
      name="Widget"
      onCount={(n) => setLine((l) => setLineCount(l, n))}
      onUnit={(u) => setLine((l) => setLineUnit(l, u))}
      onRemove={onRemove}
    />
  );
}

const caseLine: CartLineShape = {
  qty: 12,
  boxes: 1,
  pieces: 0,
  unitsPerBox: 12,
  sellBy: "CASE",
};

describe("CartRowQty", () => {
  it("names the unit and quantity: 1 Case (12 ea), then 2 Cases (24 ea) after + and the field", () => {
    render(<Harness start={caseLine} />);
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("1 Case (12 ea)");
    fireEvent.click(screen.getByRole("button", { name: "Increase Widget" }));
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    expect(screen.getByRole("spinbutton")).toHaveValue(2);
  });

  it("typing commits on blur, an empty or zero entry reverts, and nothing snaps back after a commit", () => {
    render(<Harness start={caseLine} />);
    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: "3" } });
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("1 Case (12 ea)"); // mid-keystroke: no move
    fireEvent.blur(field);
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("3 Cases (36 ea)");
    expect(field).toHaveValue(3);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(field).toHaveValue(3);
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(field).toHaveValue(3);
  });

  it("the Each toggle switches the stepper and the label together; the quantity does not move", () => {
    render(<Harness start={{ ...caseLine, qty: 24, boxes: 2 }} />);
    fireEvent.click(screen.getByRole("button", { name: /order widget by the each/i }));
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("24 Each (2 Cases)");
    expect(screen.getByRole("spinbutton")).toHaveValue(24);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Each");
  });

  it("Case is disabled while loose pieces exist (switching would round money)", () => {
    render(<Harness start={{ ...caseLine, qty: 15, boxes: 1, pieces: 3, sellBy: "EACH" }} />);
    const caseBtn = screen.getByRole("button", { name: /order widget by the case/i });
    expect(caseBtn).toBeDisabled();
    expect(caseBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("15 Each (1 Case + 3 ea)");
  });

  it("minus at 1 removes the line (as before); minus above 1 steps down one", () => {
    const onRemove = jest.fn();
    const { unmount } = render(<Harness start={caseLine} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Widget" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    unmount();
    render(<Harness start={{ ...caseLine, qty: 36, boxes: 3 }} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Widget" }));
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("every control is a 44px target (stepper segments and both toggle buttons)", () => {
    render(<Harness start={caseLine} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn.className).toMatch(/\bmin-h-11\b/);
      expect(btn.className).toMatch(/\bmin-w-11\b/);
    }
    expect(screen.getByTestId("cart-row-stepper").className).toMatch(/\bh-11\b/);
    expect(screen.getByRole("spinbutton").className).toMatch(/\bh-11\b/);
    expect(screen.getAllByRole("button")).toHaveLength(4); // minus, plus, Case, Each
  });

  it("a plain product shows the stepper and no unit toggle", () => {
    render(<Harness start={{ qty: 3, unitsPerBox: null }} />);
    expect(screen.queryByTestId("cart-line-unit")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("spinbutton")).toHaveValue(3);
  });
});

describe("CartLineUnit", () => {
  it("renders nothing for a product that is not boxed", () => {
    const { container } = render(
      <CartLineUnit item={{ qty: 2, unitsPerBox: 1 }} name="Widget" onUnit={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
