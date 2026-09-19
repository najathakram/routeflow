import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B564 — at 390px the four footer buttons overflowed the Modal's `justify-end` flex row off
 * the LEFT edge and Minimize was clipped (unreachable on a phone). JSDOM has no layout, so this
 * pins the structure that fixes it (the save actions in their own row, Minimize stacked below
 * under `sm`); the Lane F Playwright bbox probe at 390 proves the pixels. Kept out of
 * CreateOrderModal.test.tsx on purpose — Lane S-scan owns that file's scan-mode coverage.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

describe("CreateOrderModal footer layout (B564)", () => {
  it("renders all four footer actions", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    for (const name of [/minimize/i, /^cancel$/i, /save as draft/i, /^create order$/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("stacks Minimize below the save actions under sm instead of overflowing one row", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const minimize = screen.getByRole("button", { name: /minimize/i });
    const footerRow = minimize.parentElement!;
    // Under `sm`: column, reversed so the DOM-first Minimize sits at the bottom; from `sm`: one row.
    expect(footerRow).toHaveClass("flex-col-reverse", "sm:flex-row", "w-full");
    expect(minimize).toHaveClass("w-full", "sm:mr-auto", "sm:w-auto");
  });

  it("keeps Cancel / Save as Draft / Create Order together in their own row", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const actions = screen.getByRole("button", { name: /^cancel$/i }).parentElement!;
    expect(actions).toContainElement(screen.getByRole("button", { name: /save as draft/i }));
    expect(actions).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
    expect(actions).not.toContainElement(screen.getByRole("button", { name: /minimize/i }));
  });
});
