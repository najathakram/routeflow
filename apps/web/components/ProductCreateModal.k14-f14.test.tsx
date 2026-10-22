import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/** K14 F14 + P16: at 390 the last price row and the field being typed clear the pinned footer, with a soft fade. */
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

function form(): HTMLElement {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  return screen.getByRole("dialog").querySelector("form") as HTMLElement;
}

describe("New product: nothing hides behind the pinned footer", () => {
  it("every input scrolls into view with a footer-sized margin below it", () => {
    expect(form().className).toContain("[&_input]:scroll-mb-24");
  });

  it("ends with a decorative bottom fade that never takes a click", () => {
    const fade = form().querySelector("[data-scroll-fade]") as HTMLElement;
    expect(fade).not.toBeNull();
    expect(fade).toHaveAttribute("aria-hidden", "true");
    expect(fade.className).toContain("sticky");
    expect(fade.className).toContain("bottom-0");
    expect(fade.className).toContain("pointer-events-none");
    expect(fade.className).toContain("bg-gradient-to-t");
    expect(fade.className).toContain("h-12");
  });
});
