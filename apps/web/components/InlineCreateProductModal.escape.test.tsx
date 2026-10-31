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
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
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
