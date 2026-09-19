import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// JSDOM has no scrollIntoView implementation at all (not a stub — genuinely absent), and
// addLineItem's scroll-to-added-row effect calls it. No prior test in this file exercised
// that path (only the customer-not-selected submit guard), so this gap was never hit before.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

/**
 * CreateOrderModal's own zod schema (`notes`/`urgent`/`fulfillPath`) has NO
 * required fields — react-hook-form's resolver never blocks a submit. The
 * real "required" guardrails (must pick a customer, must add a line item) are
 * imperative React state checks in `onSubmit` (`setCustomerError`/
 * `setLineItemsError`), not react-hook-form/zod validation. This spec covers
 * that actual guard instead of a nonexistent zod message. A full happy path
 * (search + select a customer, search + add a product, then submit) needs a
 * much larger mocked surface — debounced customer/product search dropdowns
 * backed by 6+ query hooks — and is out of scope for this pass; recorded as a
 * finding, not faked.
 */

const createOrderMutate = jest.fn();
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
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
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
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// B499 — the product-search row's BarcodeScannerButton. The real component's webcam path
// needs getUserMedia + a dynamic @zxing/browser import, impractical in JSDOM — mock it the
// same way the sibling pages' own barcode call sites are exercised elsewhere: capture the
// live onScan/onError props so a test can trigger them directly, same as a real scan would.
let capturedOnScan: ((code: string) => void) | undefined;
let capturedOnError: ((message: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: {
    onScan: (code: string) => void;
    onError?: (message: string) => void;
    title?: string;
  }) => {
    capturedOnScan = props.onScan;
    capturedOnError = props.onError;
    return (
      <button type="button" title={props.title} aria-label={props.title}>
        {props.title}
      </button>
    );
  },
}));

// The unknown-barcode fallback: capture the props so a test can assert the modal opens with the
// scanned code as its SKU without rendering the real product form.
let capturedInlineCreate: { isOpen: boolean; initialSku?: string } | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: { isOpen: boolean; initialSku?: string }) => {
    capturedInlineCreate = props;
    return null;
  },
}));

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

describe("CreateOrderModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    capturedOnError = undefined;
    capturedInlineCreate = undefined;
  });

  it("blocks submit with 'Please select a customer' and never calls the create mutation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: /^create order$/i }));

    expect(await screen.findByText("Please select a customer")).toBeInTheDocument();
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  describe("barcode scanner (B499)", () => {
    it("renders the scan button in the product-search row", () => {
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Scan barcode" })).toBeInTheDocument();
    });

    it("a scan resolving to a product adds a line item — the same path a typed SKU takes", async () => {
      mockResolveProductByCode.mockResolvedValue({
        notFound: false,
        archived: false,
        product: { id: "prod-1", name: "Widget", pricePerUnit: "9.99", unit: "each" },
      });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Scan barcode" })).toBeInTheDocument();

      capturedOnScan!("012345678905");

      expect(await screen.findByText("Widget")).toBeInTheDocument();
      expect(mockResolveProductByCode).toHaveBeenCalledWith("012345678905");
    });

    // Characterization of the scan-resolve ladder, written BEFORE it moved to ./scan/ (LANE-S
    // step 4 prefactor): pins the four outcomes so the extraction provably changed nothing.
    it("an ARCHIVED product is never added and never routes to create-product — it toasts instead", async () => {
      mockResolveProductByCode.mockResolvedValue({
        notFound: false,
        archived: true,
        product: { id: "prod-9", name: "Retired Widget", pricePerUnit: "1", unit: "each" },
      });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

      capturedOnScan!("012345678905");

      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith({
          variant: "error",
          title: "Retired Widget is archived — reactivate to sell",
        }),
      );
      expect(screen.queryByText("Retired Widget")).not.toBeInTheDocument();
      expect(capturedInlineCreate?.isOpen).toBe(false);
    });

    it("an UNKNOWN code opens create-product with the scanned code as the SKU", async () => {
      mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

      capturedOnScan!("999000111222");

      await waitFor(() => expect(capturedInlineCreate?.isOpen).toBe(true));
      expect(capturedInlineCreate?.initialSku).toBe("999000111222");
    });

    it("a network/5xx failure toasts and does NOT open create-product (a transient error is not 'not found')", async () => {
      mockResolveProductByCode.mockRejectedValue(new Error("Network Error"));
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

      capturedOnScan!("012345678905");

      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith({
          variant: "error",
          title: "Couldn't look up the code",
          description: "Network Error",
        }),
      );
      expect(capturedInlineCreate?.isOpen).toBe(false);
    });

    it("scan-to-draft: initialScanCode is resolved exactly once per open, even across re-renders", async () => {
      mockResolveProductByCode.mockResolvedValue({
        notFound: false,
        archived: false,
        product: { id: "prod-1", name: "Widget", pricePerUnit: "9.99", unit: "each" },
      });
      const { rerender } = renderWithProviders(
        <CreateOrderModal isOpen onClose={jest.fn()} initialScanCode="012345678905" />,
      );

      expect(await screen.findByText("Widget")).toBeInTheDocument();
      rerender(<CreateOrderModal isOpen onClose={jest.fn()} initialScanCode="012345678905" />);

      expect(mockResolveProductByCode).toHaveBeenCalledTimes(1);
      expect(mockResolveProductByCode).toHaveBeenCalledWith("012345678905");
    });

    it("shows the denied-permission message from the scanner instead of a silent no-op", async () => {
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Scan barcode" })).toBeInTheDocument();

      capturedOnError!(
        "Camera access was denied. Allow camera access in your browser's site settings, then try again.",
      );

      expect(mockToast).toHaveBeenCalledWith({
        variant: "error",
        title:
          "Camera access was denied. Allow camera access in your browser's site settings, then try again.",
      });
    });
  });
});
