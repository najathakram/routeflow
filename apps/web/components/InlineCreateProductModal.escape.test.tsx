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

    fireEvent.keyDown(input, { key: "Escape" }); // 2: the window only
    expect(windowOpen()).toBe(false);
    expect(builderClosed).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" }); // 3: the builder's own
    expect(builderClosed).toHaveBeenCalledTimes(1);
  });

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
