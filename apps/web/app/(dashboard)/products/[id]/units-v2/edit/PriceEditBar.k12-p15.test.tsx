import * as React from "react";
import { render, screen } from "@testing-library/react";
import { PriceEditBar } from "./PriceEditBar";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K12 P15: the bar's status words while Change prices is open were underlined like a link. jsdom lays nothing out,
// so this pins the class strings. Same mocked draft as the K11-18 height test.

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

describe("K12 P15: 'Finish Change prices first.' reads as status, not a link", () => {
  it("is not underlined, and is still a focusable button that goes to the panel", () => {
    render(<PriceEditBar changePricesOpen />);
    const b = screen.getByRole("button", { name: "Finish Change prices first." });
    expect(b.className.split(/\s+/)).not.toContain("underline");
    expect(b.className).toContain("focus-visible:outline");
  });
});
