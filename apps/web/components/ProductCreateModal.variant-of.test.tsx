import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * The "Variant of" row on a tenant with no products yet: the picker and its scan button are disabled, and the row says
 * why (helper text linked to the input, the reason in the camera button's name). Also the New product modal's entry
 * animation, which must not run under prefers-reduced-motion.
 */

let mockProducts: { data: unknown[] } | undefined;
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProducts: () => ({ data: mockProducts }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));

const REASON = "Add a product first to make variants.";
const SCAN_NAME = "Scan a variant (add a product first to make variants)";
const SCAN_TITLE = "Scan a variant's barcode to auto-select its parent";

function open() {
  return renderWithProviders(
    <ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />,
  );
}
const picker = () => {
  const row = document.querySelector('[data-reserved-row="variant-of"]')!;
  return row.querySelector("input") as HTMLInputElement;
};

describe("Variant of with no products", () => {
  beforeEach(() => {
    mockProducts = { data: [] };
  });

  it("disables the picker and says why, linked with aria-describedby", () => {
    open();
    expect(picker()).toBeDisabled();
    const help = screen.getByText(REASON);
    expect(help.id).not.toBe("");
    expect(picker()).toHaveAttribute("aria-describedby", help.id);
  });

  it("shows the reason INSIDE the field's own box: no extra block, no extra line", () => {
    open();
    const help = screen.getByText(REASON);
    const frame = picker().closest("div.rounded-lg")!;
    // inside the picker's bordered frame, in the row that holds the input, not after it
    expect(frame.contains(help)).toBe(true);
    expect(help.closest('[data-reserved-row="variant-of"]')).not.toBeNull();
    expect(help.tagName).toBe("SPAN");
    // out of the flow: it overlays the input, so the row height cannot change
    expect(help.className).toContain("absolute");
    // the row is still label + field (nothing was appended after the field)
    const row = help.closest('[data-reserved-row="variant-of"]')!;
    expect(Array.from(row.children).map((c) => c.tagName)).toEqual(["LABEL", "DIV"]);
    // muted but legible: a body-muted token, not the pale placeholder grey
    expect(help.className).toContain("text-navy/70");
    expect(help.className).not.toContain("text-navy/30");
  });

  it("keeps the placeholder empty so the reason is not drawn twice", () => {
    open();
    expect(picker().placeholder).toBe("");
  });

  it("gives the disabled picker a muted fill from the design tokens", () => {
    open();
    const frame = picker().closest("div.rounded-lg")!;
    expect(frame.className).toContain("bg-surface-raised");
    expect(frame.className).not.toMatch(/(^|\s)bg-white(\s|$)/);
  });

  it("disables the scan button and carries the reason in its accessible name", () => {
    open();
    const scan = screen.getByRole("button", { name: SCAN_NAME });
    expect(scan).toBeDisabled();
    expect(screen.queryByRole("button", { name: SCAN_TITLE })).toBeNull();
  });
});

describe("Variant of with products", () => {
  beforeEach(() => {
    mockProducts = {
      data: [
        { id: "p1", name: "Cola", unit: "case", pricePerUnit: "10.00", parentProductId: null },
      ],
    };
  });

  it("enables the picker and the scan button, with no helper text", () => {
    open();
    expect(picker()).toBeEnabled();
    expect(picker()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(REASON)).toBeNull();
    expect(screen.getByRole("button", { name: SCAN_TITLE })).toBeEnabled();
    expect(picker().closest("div.rounded-lg")!.className).not.toContain("bg-surface-raised");
  });
});

describe("Variant of while the catalog is still loading", () => {
  it("does not claim there are no products yet: no helper text, scan not disabled", () => {
    mockProducts = undefined;
    open();
    expect(screen.queryByText(REASON)).toBeNull();
    expect(screen.getByRole("button", { name: SCAN_TITLE })).toBeEnabled();
  });
});

describe("New product modal entry animation", () => {
  it("does not animate under prefers-reduced-motion (dialog and backdrop)", () => {
    mockProducts = { data: [] };
    open();
    expect(screen.getByRole("dialog").className).toContain("motion-reduce:!animate-none");
    const overlay = document.querySelector("[data-modal-overlay]");
    expect(overlay?.className).toContain("motion-reduce:!animate-none");
  });
});
