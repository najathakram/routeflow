import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { screen } from "@testing-library/react";
import { getStoredUser } from "@/lib/auth";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { draftKey, EMPTY_DRAFT_FORM } from "./product-create/product-create-draft";

/**
 * Layout stability of the New product form (K7 Mac mini proof: the Name field moved ~13 px in the
 * first second). jsdom cannot measure pixels, so this pins the STRUCTURE that makes a shift
 * impossible: nothing is inserted before the Name field when the async lists arrive, and the rows
 * that depend on them are mounted from the first render inside a reserved-size wrapper.
 */

const mockAsync: { products: unknown; sections: unknown } = {
  products: undefined,
  sections: undefined,
};

jest.mock("@/lib/auth", () => ({
  ...jest.requireActual("@/lib/auth"),
  getStoredUser: jest.fn(),
}));
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProducts: () => ({ data: mockAsync.products }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: mockAsync.sections }),
  useRegulatedTemplates: () => ({ data: undefined }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const PRODUCTS = {
  data: [
    { id: "p1", name: "Cola", unit: "case", pricePerUnit: "10.00", parentProductId: null },
    { id: "p2", name: "Chips", unit: "case", pricePerUnit: "8.00", parentProductId: null },
  ],
};
const SECTIONS = [{ id: "s1", name: "Tobacco", isActive: true, reportTemplate: null }];

const BANNER = "units-v2-restore-banner";

function describeNode(el: Element): string {
  return [
    el.tagName.toLowerCase(),
    el.id,
    el.getAttribute("data-testid") ?? "",
    el.getAttribute("data-reserved-row") ?? "",
    el.getAttribute("role") ?? "",
    el.getAttribute("type") ?? "",
  ].join("|");
}

/** Every element from the dialog's start up to and including the Name input, in document order. */
function aboveAndIncludingName(): { nodes: Element[]; signature: string[]; name: HTMLElement } {
  const dialog = screen.getByRole("dialog");
  const name = screen.getByLabelText("Name *");
  const all = Array.from(dialog.querySelectorAll("*"));
  const nodes = all.slice(0, all.indexOf(name) + 1);
  return { nodes, signature: nodes.map(describeNode), name };
}

function renderModal() {
  return renderWithProviders(
    <ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />,
  );
}

function resolveAsync(view: ReturnType<typeof renderModal>) {
  mockAsync.products = PRODUCTS;
  mockAsync.sections = SECTIONS;
  view.rerender(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
}

beforeEach(() => {
  localStorage.clear();
  mockAsync.products = undefined;
  mockAsync.sections = undefined;
  (getStoredUser as jest.Mock).mockReset();
  (getStoredUser as jest.Mock).mockReturnValue({ id: "user-a", tenantSlug: "acme" });
});

describe.each([
  ["without a saved draft", false],
  ["with a saved draft (restore banner)", true],
])("New product form layout stability, %s", (_label, withDraft) => {
  beforeEach(() => {
    if (withDraft) {
      localStorage.setItem(
        draftKey()!,
        JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          fields: { ...EMPTY_DRAFT_FORM, name: "Cola" },
        }),
      );
    }
  });

  it("inserts nothing before the Name field when the async lists arrive", () => {
    const view = renderModal();
    expect(!!screen.queryByTestId(BANNER)).toBe(withDraft);
    const pending = aboveAndIncludingName();

    resolveAsync(view);
    const resolved = aboveAndIncludingName();

    expect(resolved.signature).toEqual(pending.signature);
    // The very same DOM nodes: nothing above Name was unmounted and re-mounted.
    expect(resolved.nodes).toHaveLength(pending.nodes.length);
    resolved.nodes.forEach((node, i) => expect(node).toBe(pending.nodes[i]));
    expect(resolved.name).toBe(pending.name);
  });

  it("mounts the Variant of row from the first render, in a reserved-size wrapper, before Name", () => {
    const view = renderModal();
    const reserved = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>('[data-reserved-row="variant-of"]');
    expect(reserved).not.toBeNull();
    expect(reserved!.className).toMatch(/\bmin-h-\[\d+px\]/);
    expect(reserved!.textContent).toContain("Variant of");
    // Document order: the reserved row comes before the Name field.
    const name = screen.getByLabelText("Name *");
    expect(reserved!.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    resolveAsync(view);
    expect(screen.getByRole("dialog").querySelector('[data-reserved-row="variant-of"]')).toBe(
      reserved,
    );
  });
});

describe("New product form: the dialog frame does not move content (source + class pins)", () => {
  const source = fs.readFileSync(path.join(__dirname, "ProductCreateModal.tsx"), "utf8");
  const modalSource = fs.readFileSync(
    path.join(__dirname, "../../../packages/ui/src/web/Modal.tsx"),
    "utf8",
  );

  it("renders the async Variant of row through the reserved-size wrapper class", () => {
    expect(source).toMatch(/const RESERVED_ROW = "min-h-\[\d+px\]"/);
    expect(source).toMatch(/data-reserved-row="variant-of"\s+className=\{`[^`]*\$\{RESERVED_ROW\}/);
    // The row is never mounted conditionally on the async catalog.
    expect(source).not.toMatch(
      /allProducts\.filter\(\(p\) => !p\.parentProductId\)\.length > 0 &&/,
    );
  });

  it("anchors the dialog to the top and enters with a fade only (no zoom or slide)", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("top-[4vh]");
    expect(dialog.className).toContain("translate-y-0");
    expect(dialog.className).not.toContain("-translate-y-1/2");
    expect(dialog.className).not.toContain("zoom-in-95");
    expect(dialog.className).not.toContain("slide-in-from-top");
    expect(dialog.className).toContain("fade-in-0");
    // The enter keyframe starts at translate-x 0: x stays pinned at the resting -50%.
    expect(dialog.className).toContain("slide-in-from-left-1/2");
    // The shared Modal keeps its centred zoom + slide by default; the form opts into "top".
    expect(modalSource).toMatch(/anchor\?: "center" \| "top"/);
    expect(source).toMatch(/anchor="top"/);
  });
});
