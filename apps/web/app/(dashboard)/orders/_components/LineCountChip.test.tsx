import { render, screen } from "@testing-library/react";
import { LineCountChip } from "./LineCountChip";

// W-1185: the count the clerk checks against the goods; boxes and pieces are never added.
describe("LineCountChip", () => {
  it("shows lines, boxes and pieces apart", () => {
    render(
      <LineCountChip
        lines={[
          { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 },
          { qty: 6, unit: "each" },
        ]}
      />,
    );
    const chip = screen.getByTestId("line-count-chip");
    expect(chip).toHaveTextContent("2 lines · 2 boxes · 6 pcs");
  });

  // W-1185 fix 1 (F7): the till's scan feedback already announces each scan, and a builder keystroke
  // would announce every partial count, so the chip is plain text, not a live region.
  it("is not a live region", () => {
    render(<LineCountChip lines={[{ qty: 6, unit: "each" }]} />);
    const chip = screen.getByTestId("line-count-chip");
    expect(chip).not.toHaveAttribute("role");
    expect(chip).not.toHaveAttribute("aria-live");
  });

  it("renders nothing for an empty list and for lines with no quantity", () => {
    const { container, rerender } = render(<LineCountChip lines={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LineCountChip lines={[{ qty: 0, unit: "each" }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the text follows the lines and the changed text remounts its pulse span", () => {
    const first = [{ qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 }];
    const { rerender } = render(<LineCountChip lines={first} />);
    const before = screen.getByTestId("line-count-chip").firstElementChild;
    expect(screen.getByTestId("line-count-chip")).toHaveTextContent("1 line · 1 box");
    rerender(<LineCountChip lines={[...first, { qty: 3, unit: "each" }]} />);
    const after = screen.getByTestId("line-count-chip").firstElementChild;
    expect(screen.getByTestId("line-count-chip")).toHaveTextContent("2 lines · 1 box · 3 pcs");
    expect(after).not.toBe(before);
    expect(after).toHaveClass("rf-count-pulse");
  });
});
