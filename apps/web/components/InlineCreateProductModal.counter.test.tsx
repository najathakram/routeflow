import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineCreateProductModal } from "./InlineCreateProductModal";

/**
 * W-1042 (SA-1062 MUSTs 9 and 14a): the new-item window at the counter. `requirePrice` keeps Save off until the price
 * is above $0 (a blank price used to go out as "0" and sell a $0 line); the window is a real dialog to the counter, so
 * its scan guard (`[role="dialog"][data-state="open"]`) sees it, Esc closes it, and the first empty field has the cursor.
 */
const createMutate = jest.fn();
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: createMutate, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  useProductCategories: () => ({ data: [] }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

function mount(props: Partial<React.ComponentProps<typeof InlineCreateProductModal>> = {}) {
  const onClose = jest.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal isOpen onClose={onClose} onCreated={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
  return { onClose };
}

const save = () => screen.getByRole("button", { name: /create product/i }) as HTMLButtonElement;
const form = () => save().closest("form")!;
const price = () => screen.getByPlaceholderText("0.00") as HTMLInputElement;
const PRICE_HINT = "Enter a price to sell this item.";

beforeEach(() => createMutate.mockReset());

describe("W-1042 MUST 9: requirePrice", () => {
  it("R5: a blank price leaves Save disabled and says why", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    expect(save().disabled).toBe(true);
    expect(screen.queryByText(PRICE_HINT)).not.toBeNull();
  });

  it("R5: $0 is not a price; the first cent turns Save on and the line goes", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    fireEvent.change(price(), { target: { value: "0" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(price(), { target: { value: "0.01" } });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(PRICE_HINT)).toBeNull();
  });

  it("R5: a submit with no price sends nothing (Enter in a field cannot get round the button)", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    fireEvent.submit(form());
    expect(createMutate).toHaveBeenCalledTimes(0);
  });

  it("guard: without requirePrice (the builder's mounts) a blank price still goes out as 0 and Save is on", () => {
    mount({ initialName: "Fresh Pie" });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(PRICE_HINT)).toBeNull();
    fireEvent.submit(form());
    expect(createMutate.mock.calls[0][0]).toMatchObject({ pricePerUnit: "0" });
  });
});

describe("W-1042 MUST 14a: a real dialog to the counter", () => {
  it("is a modal dialog, open, named New product", () => {
    mount({ initialName: "Fresh Pie" });
    const dialog = document.querySelector('[role="dialog"][data-state="open"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "New product" })).not.toBeNull();
  });

  it("is not a dialog while closed", () => {
    mount({ isOpen: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Esc closes it", () => {
    const { onClose } = mount({ initialName: "Fresh Pie" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the cursor goes to the first EMPTY field: name, then SKU, then unit", () => {
    const nameField = "e.g. Sourdough Bread";
    const skuField = "Scan or type";
    const unitField = "e.g. case, kg, unit";
    const { unmount } = renderOnce({});
    expect(document.activeElement).toBe(screen.getByPlaceholderText(nameField));
    unmount();
    const second = renderOnce({ initialName: "Fresh Pie" });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(skuField));
    second.unmount();
    renderOnce({ initialName: "Fresh Pie", initialSku: "200000009999" });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(unitField));
  });
});

function renderOnce(props: Partial<React.ComponentProps<typeof InlineCreateProductModal>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal isOpen onClose={jest.fn()} onCreated={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
}
