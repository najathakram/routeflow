import * as React from "react";
import { render, screen } from "@testing-library/react";
import { PriceEditBar } from "./PriceEditBar";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K11-18 at 390: the bar jumped 4 px when Change prices opened (limit 1 px). The "Finish Change prices first." link is
// wider than Cancel + Save, so at phone width it squeezed the plain count message ("Nothing changed yet") onto two
// lines (+4 px over the 36 px slot). While the panel is open the plain count steps aside visually below sm (it is
// stale next to the panel, and still read by screen readers), so the row is exactly one slot high in both states.
// jsdom lays nothing out: these are the class strings that keep the two states the same height.

const mockDraft = {
  editingIn: "inline",
  editing: true,
  grid: { rows: [] },
  problems: [] as unknown[],
  count: 0,
  appliedLead: null,
  conflicts: [] as string[],
  bakedTitles: [] as string[],
  notice: null,
  saveError: null,
  canSave: false,
  saving: false,
  dirty: false,
  discard: jest.fn(),
  save: jest.fn(),
  reload: jest.fn(),
  tierName: () => "",
};
jest.mock("./usePriceDraft", () => ({ usePriceDraft: () => mockDraft }));

const cls = (el: Element) => el.className.split(/\s+/);

describe("K11-18: the bar is the same height with Change prices open or closed", () => {
  it("same bar chrome (padding, border, margin) in both states", () => {
    const { rerender } = render(<PriceEditBar changePricesOpen={false} />);
    const closed = screen.getByTestId(T.editbar).className;
    rerender(<PriceEditBar changePricesOpen />);
    expect(screen.getByTestId(T.editbar).className).toBe(closed);
  });

  it("both button slots are one 36 px control high (h-9 buttons, min-h-9 for the link slot)", () => {
    const { rerender } = render(<PriceEditBar changePricesOpen={false} />);
    for (const id of [T.ebCancel, T.ebSave]) expect(cls(screen.getByTestId(id))).toContain("h-9");
    rerender(<PriceEditBar changePricesOpen />);
    const slot = screen.getByRole("button", { name: "Finish Change prices first." }).parentElement!;
    expect(cls(slot)).toContain("min-h-9");
    expect(cls(slot)).not.toContain("border");
  });

  it("the plain count message does not wrap beside the wider link below sm, and is still in the DOM", () => {
    const { rerender } = render(<PriceEditBar changePricesOpen={false} />);
    const message = () => screen.getByText("Nothing changed yet");
    expect(cls(message())).not.toContain("max-sm:sr-only");
    rerender(<PriceEditBar changePricesOpen />);
    expect(message()).toBeInTheDocument();
    // K14 P08: sr-only at every width while Change prices is open (one visible status, not three)
    expect(cls(message())).toContain("sr-only");
  });
});
