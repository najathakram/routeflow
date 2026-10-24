import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SearchableProductPicker } from "./SearchableProductPicker";

/**
 * B1215 C7: the async (whole-catalog) product picker never offers a FAMILY as a line. A family's
 * variants stand in for it under "<Parent> - <Variant>" with their unit; a static curated list
 * (used for "choose a parent") still shows families.
 */

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  sku: "POD-MINT",
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  isActive: true,
  variants: [MINT],
};
const COLA = { id: "p-cola", name: "Sample Cola", kind: "STANDARD", unit: "case", isActive: true };
// A STABLE result object, as react-query gives (a fresh one per render would loop the picker's effects).
const RESULT = { data: { data: [FAMILY, COLA] } };
jest.mock("@/lib/api/products", () => ({
  useProducts: () => RESULT,
}));

describe("SearchableProductPicker (B1215 C7)", () => {
  it("async mode: lists variants under the parent name with their unit, never the family", () => {
    const onChange = jest.fn();
    render(<SearchableProductPicker async value="" onChange={onChange} />);
    fireEvent.focus(screen.getByPlaceholderText("Search products…"));
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("Sample Pod - Mint");
    expect(options[0]).toContain("each");
    expect(options.some((t) => /^Sample Pod(?! -)/.test(t))).toBe(false);
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    expect(onChange).toHaveBeenCalledWith("v-mint", expect.objectContaining({ id: "v-mint" }));
  });

  it("static mode: a curated list (e.g. choose a parent) still shows families", () => {
    render(<SearchableProductPicker value="" onChange={jest.fn()} products={[FAMILY, COLA]} />);
    fireEvent.focus(screen.getByPlaceholderText("Search products…"));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // Scope to the options: the floating preview repeats the highlighted row's name.
    expect(options[0]).toHaveTextContent("Sample Pod");
  });
});
