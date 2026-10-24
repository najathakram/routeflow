import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B564 — at 390px the four footer buttons overflowed the Modal's `justify-end` flex row off
 * the LEFT edge and Minimize was clipped (unreachable on a phone). JSDOM has no layout, so this
 * pins the structure that fixes it. Since r4 Q08 Minimize lives in the header beside the X and the footer Close
 * (a repeat of the X) is gone, so the footer is one wrapping row at every width; the UI proof at 390 shows the pixels. Kept out of
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
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  // The modal reads the developer_mode addon (useScanV2 -> useDeveloperMode -> useTenantAddons).
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

describe("CreateOrderModal footer layout (B564, r4 Q08)", () => {
  it("renders the footer actions, with Minimize in the header and the X as the only Close", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const footer = screen.getByTestId("create-order-footer");
    expect(footer).toContainElement(screen.getByRole("button", { name: /save as draft/i }));
    expect(footer).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
    expect(footer).not.toContainElement(screen.getByRole("button", { name: /minimize/i }));
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("is one wrapping row at every width (no stacked column), so 390px does not overflow", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const footer = screen.getByTestId("create-order-footer");
    expect(footer).toHaveClass("flex", "w-full", "flex-wrap");
    expect(footer.className).not.toMatch(/flex-col/);
  });

  it("keeps Save as Draft / Create Order together in their own wrapping group", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const actions = screen.getByRole("button", { name: /save as draft/i }).parentElement!;
    expect(actions).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
    // Wrap, don't overflow: the spinners `loading` adds to two buttons widen this row at 390px.
    expect(actions).toHaveClass("flex-wrap", "justify-end");
  });

  it("every footer action is a 44 px touch target under sm and keeps its own height from sm up (row 344b)", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    for (const name of [/save as draft/i, /^create order$/i]) {
      const button = screen.getByRole("button", { name });
      // max-sm:h-11 = 2.75rem = 44 px below the sm breakpoint only; no unprefixed height override.
      expect(button).toHaveClass("max-sm:h-11");
      expect(button.className).not.toMatch(/(^|s)h-11(s|$)/);
    }
  });
});
