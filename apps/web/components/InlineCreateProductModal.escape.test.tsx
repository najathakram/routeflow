import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Modal } from "@routeflow/ui/web";
import { InlineCreateProductModal } from "./InlineCreateProductModal";

/**
 * SA-1066 FL1: the New product window was the one window that ignored Escape (only X or Cancel closed it). Escape now
 * takes the exact path Cancel takes: `onClose`, with no discard question (X and Cancel ask none either). An open Unit or
 * Category list takes its own Escape first. The root stays a non-dialog (a nested role breaks the order builder's picks).
 */
const mockProducts: Array<{ id: string; name: string; isActive: boolean }> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
  useProducts: () => ({ data: { data: mockProducts } }),
  useProductCategories: () => ({ data: ["Bakery"] }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
const mount = (isOpen = true) => {
  const onClose = jest.fn();
  wrap(<InlineCreateProductModal isOpen={isOpen} onClose={onClose} onCreated={jest.fn()} />);
  return onClose;
};
const name = () => screen.getByPlaceholderText("e.g. Sourdough Bread") as HTMLInputElement;

describe("FL1: Escape closes the New product window", () => {
  it("Escape in a field calls onClose once, the same call as Cancel", () => {
    const onClose = mount();
    fireEvent.change(name(), { target: { value: "Fresh Pie" } });
    fireEvent.keyDown(name(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2); // Cancel is the same one call, with nothing in between
  });

  it("Escape with focus nowhere in the window (on the page) still closes it", () => {
    const onClose = mount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an open Category list takes the first Escape; the next one closes the window", () => {
    const onClose = mount();
    const category = screen.getByPlaceholderText("e.g. Bakery") as HTMLInputElement;
    fireEvent.focus(category);
    expect(category).toHaveAttribute("aria-controls");
    fireEvent.keyDown(category, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(category).not.toHaveAttribute("aria-controls");
    fireEvent.keyDown(category, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("an Escape that cancels an IME composition (%s) does not close the window", (_n, init) => {
    const onClose = mount();
    fireEvent.keyDown(name(), { key: "Escape", ...init });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(name(), { key: "Escape" }); // the next, plain Escape still closes
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a closed window listens to nothing", () => {
    const onClose = mount(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("no nested dialog role is added", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("inside the order builder's Modal, Escape closes the window and leaves the order open", () => {
    const onCloseOrder = jest.fn();
    const onClose = jest.fn();
    wrap(
      <Modal open onClose={onCloseOrder} title="New order">
        <InlineCreateProductModal isOpen onClose={onClose} onCreated={jest.fn()} />
      </Modal>,
    );
    fireEvent.keyDown(name(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCloseOrder).not.toHaveBeenCalled();
  });
});

/**
 * The order builder's Modal is Radix: it reads Escape at the document in the capture phase, ahead of React. With a Unit,
 * Category or parent list open the first Escape must close only that list; the second only the window; the third is the
 * builder's own. This drives the real Modal around the real window, so the capture-phase order is the real one.
 */
describe("FL1: inside the real builder Modal, one Escape closes one layer", () => {
  const builderClosed = jest.fn();
  // The builder's real wiring is `<Modal onEscapeKeyDown={handleEscape}>`: Radix calls it, from its document-capture listener,
  // for every Escape that reaches it. The spy sees what the builder would.
  const builderEscape = jest.fn();
  function Builder() {
    const [order, setOrder] = React.useState(true);
    const [win, setWin] = React.useState(true);
    return (
      <Modal
        open={order}
        onClose={() => {
          builderClosed();
          setOrder(false);
        }}
        onEscapeKeyDown={builderEscape}
        title="New order"
      >
        <InlineCreateProductModal
          isOpen={win}
          onClose={() => setWin(false)}
          onCreated={jest.fn()}
        />
      </Modal>
    );
  }
  beforeEach(() => {
    builderClosed.mockClear();
    builderEscape.mockClear();
    mockProducts.length = 0;
    mockProducts.push({ id: "p1", name: "Sample Cola", isActive: true });
  });
  const windowOpen = () => screen.queryByPlaceholderText("e.g. Sourdough Bread") !== null;

  it.each([
    ["Category", () => screen.getByPlaceholderText("e.g. Bakery")],
    ["Unit", () => screen.getByPlaceholderText("e.g. case, kg, unit")],
    ["Variant of", () => screen.getByPlaceholderText("Standalone product (type to search)\u2026")],
  ])("%s list open: list, then window, then builder", (_name, field) => {
    wrap(<Builder />);
    const input = field() as HTMLInputElement;
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-controls");

    fireEvent.keyDown(input, { key: "Escape" }); // 1: the list only
    expect(input).not.toHaveAttribute("aria-controls");
    expect(windowOpen()).toBe(true);
    expect(builderClosed).not.toHaveBeenCalled();
    // the builder's handler is reached (no stopPropagation here, the list must get the key) but sees it marked handled
    expect(builderEscape).toHaveBeenCalledTimes(1);
    expect(builderEscape.mock.calls[0][0].defaultPrevented).toBe(true);

    builderEscape.mockClear();
    fireEvent.keyDown(input, { key: "Escape" }); // 2: the window only
    expect(windowOpen()).toBe(false);
    expect(builderClosed).not.toHaveBeenCalled();
    // stopPropagation: the key never reaches the builder's Radix listener, so nothing of the builder's runs on it
    expect(builderEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" }); // 3: the builder's own
    expect(builderEscape).toHaveBeenCalledTimes(1);
    expect(builderClosed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])(
    "a composing Escape (%s) is marked handled, so the builder stays open; the window stays too",
    (_n, init) => {
      wrap(<Builder />);
      fireEvent.keyDown(name(), { key: "Escape", ...init });
      expect(builderClosed).not.toHaveBeenCalled();
      expect(windowOpen()).toBe(true);
      // Radix still hands the key to the builder's handler, marked, so its own Escape paths see "handled" and do nothing
      expect(builderEscape).toHaveBeenCalledTimes(1);
      expect(builderEscape.mock.calls[0][0].defaultPrevented).toBe(true);
    },
  );

  it("an open list with nothing in it (no match) still closes on the first Escape, not stuck", () => {
    wrap(<Builder />);
    const category = screen.getByPlaceholderText("e.g. Bakery") as HTMLInputElement;
    fireEvent.change(category, { target: { value: "zzzz" } });
    fireEvent.keyDown(category, { key: "Escape" });
    expect(category).not.toHaveAttribute("aria-controls");
    fireEvent.keyDown(category, { key: "Escape" });
    expect(windowOpen()).toBe(false);
    expect(builderClosed).not.toHaveBeenCalled();
  });
});
