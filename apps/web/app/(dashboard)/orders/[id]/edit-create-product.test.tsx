/**
 * An item that is not listed can be created from the order-detail editor, by typing its name or by scanning its code
 * (owner bug: "if the product is not listed, we should be able to add a new product from then and there").
 *
 * The editor's scan miss already opened the New product window, but the window got the typed WORDS in its SKU field
 * (and nothing in Name), and a typed name that matched nothing showed no way to create it at all. Now:
 *   - typed text, with or without matches, ends in a "Create new product" row (the Create Order builder's own row);
 *   - the window starts with words in Name and a code in SKU (`newProductPrefill`, the same helper the counter uses);
 *   - Save puts the new product on the order as a normal line with its own price and unit.
 * The window itself is stubbed here: its fields and its save are `InlineCreateProductModal`'s own tests.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));

let mockListed: any[] = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockListed } }),
}));
const resolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (code: string) => resolveProductByCode(code),
}));

const NEW_PRODUCT = {
  id: "p-created",
  name: "Oat Latte",
  sku: "OAT-1",
  unit: "case",
  pricePerUnit: "12.50",
  unitsPerBox: null,
  isActive: true,
};

// The window, stubbed: it shows what it was opened with and saves a fixed product.
let windowProps: { isOpen: boolean; initialName?: string; initialSku?: string } | null = null;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: any) => {
    windowProps = props;
    if (!props.isOpen) return null;
    return (
      <div role="dialog" aria-label="New product">
        <span data-testid="window-name">{props.initialName ?? ""}</span>
        <span data-testid="window-sku">{props.initialSku ?? ""}</span>
        <button type="button" onClick={() => props.onCreated(NEW_PRODUCT)}>
          Save new product
        </button>
        <button type="button" onClick={props.onClose}>
          Close new product
        </button>
      </div>
    );
  },
}));

function line(): EditItemState {
  return {
    id: "li-1",
    originalProductId: "p1",
    originalProductName: "Widget",
    originalQty: 2,
    productId: "p1",
    productName: "Widget",
    qty: 2,
    unitPrice: 10,
    basePrice: 10,
    originalUnitPrice: 10,
    cancelled: false,
    unit: "each",
    unitsPerBox: null,
    boxSplit: false,
    priceType: "STANDARD",
  } as EditItemState;
}

let onAdd: jest.Mock;
function renderEditor() {
  onAdd = jest.fn();
  return renderWithProviders(
    <EditableLineItems
      items={[line()]}
      onChange={() => {}}
      onAdd={onAdd}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 12.5}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );
}

const searchBox = () => screen.getByPlaceholderText(/scan barcode or type name/i);
const createRow = () => screen.getByRole("button", { name: /^Create new product/ });

beforeEach(() => {
  mockListed = [];
  windowProps = null;
  resolveProductByCode.mockReset();
  resolveProductByCode.mockResolvedValue({ notFound: true });
});

describe("typed text that matches nothing", () => {
  it("E1: says so and offers 'Create new product' with the typed text", async () => {
    renderEditor();
    await userEvent.setup().type(searchBox(), "Oat Latte");
    expect(await screen.findByText("No products found.")).toBeInTheDocument();
    expect(createRow()).toHaveTextContent('Create new product: "Oat Latte"');
  });

  it("E3: the row opens the window with the words in Name and nothing in SKU", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "Oat Latte");
    await user.click(await screen.findByRole("button", { name: /^Create new product/ }));
    expect(screen.getByTestId("window-name")).toHaveTextContent("Oat Latte");
    expect(screen.getByTestId("window-sku")).toBeEmptyDOMElement();
  });

  it("E3: six or more digits typed go to SKU, the same rule as the Create Order row", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "012345678");
    await user.click(await screen.findByRole("button", { name: /^Create new product/ }));
    expect(screen.getByTestId("window-sku")).toHaveTextContent("012345678");
    expect(screen.getByTestId("window-name")).toBeEmptyDOMElement();
  });

  it("E6: Save puts the new product on the order as a line with its own price and unit, and clears the field", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "Oat Latte");
    await user.click(await screen.findByRole("button", { name: /^Create new product/ }));
    await user.click(screen.getByRole("button", { name: "Save new product" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    const added = onAdd.mock.calls[0][0];
    expect(added).toMatchObject({
      productId: "p-created",
      productName: "Oat Latte",
      unit: "case",
      unitPrice: 12.5,
      qty: 1,
    });
    expect(screen.queryByRole("dialog", { name: "New product" })).toBeNull();
    expect(searchBox()).toHaveValue("");
  });

  it("E6b: Close leaves the order alone", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "Oat Latte");
    await user.click(await screen.findByRole("button", { name: /^Create new product/ }));
    await user.click(screen.getByRole("button", { name: "Close new product" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "New product" })).toBeNull();
  });
});

describe("typed text that matches something", () => {
  it("E2: the matches come first and a 'Create new product' row follows them, as in Create Order", async () => {
    mockListed = [{ id: "p9", name: "Oat Milk", unit: "case", pricePerUnit: "4", isActive: true }];
    renderEditor();
    await userEvent.setup().type(searchBox(), "Oat");
    const rows = await screen.findAllByRole("button", { name: /Oat Milk|Create new product/ });
    expect(rows[0]).toHaveTextContent("Oat Milk");
    expect(rows[rows.length - 1]).toHaveTextContent('Create new product: "Oat"');
  });
});

describe("Enter in the box with nothing found", () => {
  it("E4: words go to Name, not to SKU", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "Oat Latte{Enter}");
    await waitFor(() => expect(windowProps?.isOpen).toBe(true));
    expect(screen.getByTestId("window-name")).toHaveTextContent("Oat Latte");
    expect(screen.getByTestId("window-sku")).toBeEmptyDOMElement();
  });

  it("E5: a code with a digit and no space goes to SKU, so the next scan finds the item", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.type(searchBox(), "AB12345{Enter}");
    await waitFor(() => expect(windowProps?.isOpen).toBe(true));
    expect(screen.getByTestId("window-sku")).toHaveTextContent("AB12345");
    expect(screen.getByTestId("window-name")).toBeEmptyDOMElement();
  });

  it("E7: a failed lookup offers no window (a network error is not 'the item does not exist')", async () => {
    resolveProductByCode.mockRejectedValue(new Error("network"));
    renderEditor();
    await userEvent.setup().type(searchBox(), "Oat Latte{Enter}");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(windowProps?.isOpen ?? false).toBe(false);
  });
});

describe("a scan that finds nothing", () => {
  it("E8: a wedge scan of a code goes to SKU, so the next scan finds the item", async () => {
    renderEditor();
    const input = searchBox();
    // the shared scanner button's wedge detector: fast keys, then Enter
    let t = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
    try {
      await act(async () => {
        for (const ch of "0123456789012") fireEvent.keyDown(input, { key: ch });
        fireEvent.change(input, { target: { value: "0123456789012" } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(windowProps?.isOpen).toBe(true));
      expect(screen.getByTestId("window-sku")).toHaveTextContent("0123456789012");
    } finally {
      spy.mockRestore();
    }
  });
});
