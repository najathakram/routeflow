import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { TrackedCategory } from "@/lib/api/tracked-categories";
import { SectionEditCell } from "./SectionEditCell";

/** W-926: the regulated-type select is named for the product, never for its id. */
jest.mock("@/components/SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));

const PRODUCT_ID = "3f9c1d52-8a41-4e0b-9c77-0d6f2b7a1e10";
const sections = [{ id: "s1", name: "Cigars", isActive: true }] as unknown as TrackedCategory[];
const mount = (productName?: string) =>
  renderWithProviders(
    <SectionEditCell
      productId={PRODUCT_ID}
      productName={productName}
      trackedCategoryId={null}
      trackedSubcategoryId={null}
      activeSections={sections}
      onSave={jest.fn()}
    />,
  );

describe("SectionEditCell accessible name (W-926)", () => {
  it("is 'Regulated type for <product name>' and carries no id", () => {
    mount("Acme Cigar Box");
    const select = screen.getByRole("combobox", { name: "Regulated type for Acme Cigar Box" });
    expect(select.getAttribute("aria-label")).not.toContain(PRODUCT_ID);
  });

  it("without a name it is just 'Regulated type', still no id", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Regulated type" })).toBeTruthy();
  });
});
