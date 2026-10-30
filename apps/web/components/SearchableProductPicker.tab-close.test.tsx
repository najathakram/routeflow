import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SearchableProductPicker } from "./SearchableProductPicker";

const PRODUCTS = [
  { id: "p-1", name: "Sample Cola", sku: "1" },
  { id: "p-2", name: "Sample Lemonade", sku: "2" },
];

describe("SearchableProductPicker keyboard close (W-694)", () => {
  it("W-694: Tab closes the open list", () => {
    renderWithProviders(
      <SearchableProductPicker value="" onChange={jest.fn()} products={PRODUCTS} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.queryAllByRole("option").length).toBe(2);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryAllByRole("option").length).toBe(0);
  });

  it("W-694: focus moving to another control closes the list", () => {
    renderWithProviders(
      <div>
        <SearchableProductPicker value="" onChange={jest.fn()} products={PRODUCTS} />
        <button type="button">next</button>
      </div>,
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.queryAllByRole("option").length).toBe(2);
    fireEvent.blur(input, { relatedTarget: screen.getByText("next") });
    expect(screen.queryAllByRole("option").length).toBe(0);
  });
});
