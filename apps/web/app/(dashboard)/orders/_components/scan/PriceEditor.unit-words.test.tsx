import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { LineItemRowItem } from "@/components/LineItemRow";
import { PriceEditor } from "./PriceEditor";

jest.mock("@/components/MarginHint", () => ({ MarginHint: () => <div /> }));

/** U-3a: the scan sheet reads the same unitWords() as the row, and a long tenant word truncates. */
const boxed = (o: Partial<LineItemRowItem> = {}): LineItemRowItem => ({
  tempId: "t1",
  productId: "p1",
  productName: "Soda",
  unit: "case",
  listPrice: 24,
  unitPrice: 24,
  priceType: "STANDARD",
  unitsPerBox: 6,
  boxes: 2,
  pieces: 1,
  qty: 13,
  unitCost: 6,
  ...o,
});

function setup(li: LineItemRowItem) {
  const fn = jest.fn();
  render(
    <PriceEditor
      line={li}
      marginFloor={0.15}
      floorAcked={false}
      costRevealed
      onQtyDelta={fn}
      onSetBoxes={fn}
      onSetPieces={fn}
      onSetUnitQty={fn}
      onSetSellBy={fn}
      onSetDiscountedPrice={fn}
      onSetToFloor={fn}
      onAckFloor={fn}
      onToggleCostRevealed={fn}
      onClose={fn}
    />,
  );
}

describe("PriceEditor unit words", () => {
  it("defaults print the VU-1 Box / Piece words", () => {
    setup(boxed());
    expect(screen.getByRole("button", { name: "Box" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Piece" })).toBeInTheDocument();
    expect(screen.getByLabelText("Boxes")).toBeInTheDocument();
    expect(screen.getByLabelText("Extra pieces")).toBeInTheDocument();
    expect(screen.getByText("Box price")).toBeInTheDocument();
    expect(screen.getByText(/1 box = 6 pcs/)).toHaveTextContent("13 pcs total");
  });

  it("a long tenant word shows 11 characters plus a dot in the pill, full word in aria-label", () => {
    setup(boxed({ packLabel: "Shrinkwrapped tray", baseUnitLabel: "Sachet" }));
    const pill = screen.getByRole("button", { name: "Shrinkwrapped tray" });
    expect(pill).toHaveTextContent("Shrinkwrapp.");
    expect(pill).toHaveAttribute("title", "Shrinkwrapped tray");
    expect(pill.className).toContain("max-w-[104px]");
    expect(pill.className).toContain("truncate");
    expect(screen.getByRole("button", { name: "Sachet" })).toHaveTextContent("Sachet");
    expect(screen.getByLabelText("Shrinkwrapped trays")).toBeInTheDocument();
    expect(screen.getByLabelText("Extra sachets")).toBeInTheDocument();
    expect(screen.getByText("Shrinkwrapped tray price")).toBeInTheDocument();
    const word = screen.getByTitle("Shrinkwrapped trays");
    expect(word.className).toContain("truncate");
  });
});
