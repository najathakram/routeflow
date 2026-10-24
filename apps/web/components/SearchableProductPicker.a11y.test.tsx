import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SearchableProductPicker } from "./SearchableProductPicker";

const PRODUCTS = [
  { id: "p-1", name: "Sample Cola", sku: "1" },
  { id: "p-2", name: "Sample Lemonade", sku: "2" },
];

it("the input points at the portalled list and its highlighted option", () => {
  renderWithProviders(
    <div role="dialog">
      <SearchableProductPicker value="" onChange={jest.fn()} products={PRODUCTS} />
    </div>,
  );
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const list = document.getElementById(input.getAttribute("aria-controls")!)!;
  expect(list).toHaveAttribute("data-anchored-list");
  expect(screen.getByRole("dialog").contains(list)).toBe(false);
  const options = screen.getAllByRole("option");
  expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
  expect(options[1].id).not.toBe("");
});
