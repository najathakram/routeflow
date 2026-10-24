import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProductCombobox, type ProductComboboxValue } from "./ProductCombobox";

/**
 * W-758 (review MUSTs on #3690): the vendor-bill line picker is built on the shared useListboxNav.
 * Only an arrow key arms Enter (never hover), a handled/IME Enter never picks, the combobox/listbox/option ARIA is valid
 * (options live only inside the listbox), and an open popup takes the dialog's first Escape.
 */

const PRODUCTS = [
  { id: "p1", name: "Mint Pod", sku: "MP-1", unit: "box", averageCost: "2.5" },
  { id: "p2", name: "Mango Pod", sku: "MG-1", unit: "box", averageCost: "3" },
];

jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: PRODUCTS } }),
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => null,
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const VALUE: ProductComboboxValue = { productId: "", description: "", unit: "", unitCost: "" };

function setup(extra?: { escapeRef?: React.MutableRefObject<(() => boolean) | null> }) {
  const onChange = jest.fn();
  const utils = render(
    <ProductCombobox
      value={VALUE}
      onChange={onChange}
      onCreateNew={jest.fn()}
      escapeCloseRef={extra?.escapeRef}
    />,
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input); // opens the popup
  return { onChange, input, ...utils };
}

describe("vendor-bills ProductCombobox keyboard + ARIA (W-758)", () => {
  it("MUST 5: combobox input points at a listbox that holds ONLY the options; activedescendant follows the arrow", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    options.forEach((o) => expect(listbox).toContainElement(o));
    // the "Create ..." action is not an option and lives outside the listbox
    expect(listbox).not.toContainElement(screen.getByText(/Create/));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("ArrowDown then Enter picks the highlighted product", () => {
    const { input, onChange } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ productId: "p2" }));
  });

  it("MUST 4: hovering a row does not arm Enter (a scanner Enter after a stray mouse move picks nothing)", () => {
    const { input, onChange } = setup();
    const opt = screen.getByRole("option", { name: /Mango Pod/ });
    fireEvent.mouseEnter(opt);
    fireEvent.mouseOver(opt);
    fireEvent.mouseMove(opt);
    expect(opt).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("MUST 3: an Enter another handler already consumed (defaultPrevented) never picks a row", () => {
    const onChange = jest.fn();
    render(
      <div onKeyDownCapture={(e) => e.key === "Enter" && e.preventDefault()}>
        <ProductCombobox value={VALUE} onChange={onChange} onCreateNew={jest.fn()} />
      </div>,
    );
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("IME: arrows and Enter during composition do nothing", () => {
    const { input, onChange } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dialog Escape: the open popup registers a closer the dialog calls first; closed popup leaves it empty", () => {
    const escapeRef: React.MutableRefObject<(() => boolean) | null> = { current: null };
    setup({ escapeRef });
    expect(escapeRef.current).toEqual(expect.any(Function));
    let handled = false;
    React.act(() => {
      handled = escapeRef.current?.() ?? false;
    });
    expect(handled).toBe(true);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(escapeRef.current).toBeNull();
  });

  it("Tab still closes the popup (shared useDismissOnLeave)", () => {
    const { input } = setup();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
