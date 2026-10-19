import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * O3 (P01/P02, apple-ux run 2026-10-16): the order total sat at the bottom of the scrolling
 * body, hidden behind the sticky footer at 1440 and 390 at the moment of "Create Order". The
 * total now lives IN the footer beside the primary action. JSDOM has no layout, so this pins the
 * structure (wrap/min-w-0/tabular-nums, DOM order for the stacked layout); the Playwright bbox
 * probe at 1440/768/390 proves the pixels.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const BIG = {
  id: "p-big",
  name: "Sample Pallet",
  sku: "900800700",
  unit: "each",
  pricePerUnit: "12345.67",
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [BIG] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

async function addBigLine() {
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: "pallet" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /sample pallet/i }));
}

describe("CreateOrderModal footer total (O3, P01/P02)", () => {
  it("shows no footer total while the order has no lines", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.queryByTestId("create-order-footer-total")).not.toBeInTheDocument();
  });

  it("puts the full formatted total in the footer, beside Create Order", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addBigLine();
    const total = await screen.findByTestId("create-order-footer-total");
    // The whole string in ONE text node, no truncation.
    expect(within(total).getByText("$12345.67")).toBeInTheDocument();
    const footerRow = screen.getByRole("button", { name: /minimize/i }).parentElement!;
    expect(footerRow).toContainElement(total);
    expect(footerRow).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
  });

  it("is built never to clip: min-w-0, tabular-nums, no fixed width", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addBigLine();
    const total = await screen.findByTestId("create-order-footer-total");
    expect(total).toHaveClass("min-w-0", "tabular-nums");
    expect(total.className).not.toMatch(/(^|\s)w-\d/);
    expect(total.className).not.toMatch(/truncate|overflow-hidden/);
  });

  it("stacks ABOVE the buttons under sm (DOM-last in the col-reverse row) and sits before them from sm", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addBigLine();
    const total = await screen.findByTestId("create-order-footer-total");
    const footerRow = screen.getByRole("button", { name: /minimize/i }).parentElement!;
    expect(footerRow).toHaveClass("flex-col-reverse", "sm:flex-row");
    // col-reverse: DOM-last renders on top, so the total is the last child.
    expect(footerRow.lastElementChild).toBe(total);
    // From sm it is reordered between Minimize and the action row.
    expect(total).toHaveClass("sm:order-1");
    const actions = screen.getByRole("button", { name: /^cancel$/i }).parentElement!;
    expect(actions).toHaveClass("sm:order-2");
  });

  it("tracks the body total", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addBigLine();
    await waitFor(() =>
      expect(screen.getByTestId("create-order-footer-total")).toHaveTextContent("$12345.67"),
    );
  });
});
