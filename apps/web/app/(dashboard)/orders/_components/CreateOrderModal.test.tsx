import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act, fireEvent } from "@/test-utils/render";
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
// Mutable so a test can put a customer in the picker / give them per-product tier prices.
let mockCustomers: Array<Record<string, unknown>> = [];
let mockCustomerPrices: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  // Like the real hook: nothing until a customer is selected.
  useCustomerPrices: (customerId?: string) => ({ data: customerId ? mockCustomerPrices : [] }),
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
let capturedOnOpenContinuous: (() => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: {
    onScan: (code: string) => void;
    onError?: (message: string) => void;
    onOpenContinuous?: () => void;
    title?: string;
  }) => {
    capturedOnScan = props.onScan;
    capturedOnError = props.onError;
    capturedOnOpenContinuous = props.onOpenContinuous;
    return (
      <button type="button" title={props.title} aria-label={props.title}>
        {props.title}
      </button>
    );
  },
}));

// NOTE: this stubs InlineCreateProductModal for EVERY test in this file (none rendered the real
// one). A test that needs the real create-product form must un-mock it locally.
// The unknown-barcode fallback: capture the props so a test can assert the modal opens with the
// scanned code as its SKU without rendering the real product form.
let capturedInlineCreate: { isOpen: boolean; initialSku?: string } | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: { isOpen: boolean; initialSku?: string }) => {
    capturedInlineCreate = props;
    return null;
  },
}));

// scan_v2: the flag and the camera are the two seams. The flag is a mutable stub; the camera hook
// hands the test the screen's onDetect so a barcode can be injected without getUserMedia.
let mockScanV2 = false;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => mockScanV2,
}));
let cameraDetect: ((code: string) => void) | undefined;
let cameraEnabled: boolean | undefined;
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: ({
    enabled,
    onDetect,
  }: {
    enabled: boolean;
    onDetect: (c: string) => void;
  }) => {
    cameraDetect = onDetect;
    cameraEnabled = enabled;
    return {
      videoRef: { current: null },
      torchAvailable: false,
      torchOn: false,
      toggleTorch: jest.fn(),
      refocus: jest.fn(),
      error: null,
    };
  },
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));

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
    capturedOnOpenContinuous = undefined;
    mockCustomers = [];
    mockCustomerPrices = [];
    cameraDetect = undefined;
    cameraEnabled = undefined;
    mockScanV2 = false;
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

    // Pins that the incoming code is resolved on open. It does NOT prove the consume-once guard:
    // with the draft hooks mocked to no-ops none of the effect's deps change on a re-render, so the
    // effect would not re-run even without `scanConsumedRef` — that ordering-sensitive guard is
    // why the effect stays in the modal rather than moving into ./scan/.
    it("scan-to-draft: initialScanCode is resolved on open and re-rendering with it unchanged does not re-resolve", async () => {
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

  describe("scan_v2 - the accumulating scan screen", () => {
    const widget = {
      notFound: false,
      archived: false,
      product: { id: "prod-1", name: "Widget", pricePerUnit: "9.99", unit: "each" },
    };
    const openScreen = async () => {
      mockScanV2 = true;
      const utils = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      act(() => capturedOnOpenContinuous!());
      await screen.findByRole("dialog", { name: "Scan items" });
      return utils;
    };
    const scanCode = async (code: string) => {
      await act(async () => {
        cameraDetect!(code);
      });
    };

    it("flag OFF (the default): the scan button gets no continuous handler - behaviour unchanged", () => {
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(capturedOnOpenContinuous).toBeUndefined();
    });

    it("flag ON: the scan button opens the screen INSTEAD of the single-shot overlay, and the Dialog closes", async () => {
      mockScanV2 = true;
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(screen.getByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
      expect(capturedOnOpenContinuous).toBeDefined();

      act(() => capturedOnOpenContinuous!());

      expect(await screen.findByRole("dialog", { name: "Scan items" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Create Order" })).not.toBeInTheDocument();
      expect(cameraEnabled).toBe(true);
    });

    it("a scan adds the line through the SAME resolver - shown in the screen with a running total", async () => {
      mockResolveProductByCode.mockResolvedValue(widget);
      await openScreen();

      await scanCode("012345678905");

      expect(await screen.findByText("Widget")).toBeInTheDocument();
      expect(screen.getByText("1 item · $9.99")).toBeInTheDocument();
      expect(mockResolveProductByCode).toHaveBeenCalledWith("012345678905");
    });

    it("a repeat scan of the same product increments its quantity, never duplicates the row", async () => {
      mockResolveProductByCode.mockResolvedValue(widget);
      await openScreen();

      await scanCode("111");
      await screen.findByText("Widget");
      await scanCode("222"); // a different barcode for the same product (past the gate)

      await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument());
      expect(screen.getAllByText("Widget")).toHaveLength(1);
    });

    it("Done returns to the order builder with the scanned lines intact", async () => {
      mockResolveProductByCode.mockResolvedValue(widget);
      await openScreen();
      await scanCode("012345678905");
      await screen.findByText("Widget");

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(await screen.findByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Scan items" })).not.toBeInTheDocument();
      expect(screen.getByText("Widget")).toBeInTheDocument();
    });

    it("Undo removes a line the scan CREATED", async () => {
      mockResolveProductByCode.mockResolvedValue(widget);
      await openScreen();
      await scanCode("012345678905");
      await screen.findByText("Widget");

      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));

      await waitFor(() => expect(screen.queryByText("Widget")).not.toBeInTheDocument());
      expect(screen.getByText("0 items · $0.00")).toBeInTheDocument();
    });

    it("Undo of a repeat scan takes ONE unit back and keeps the line", async () => {
      mockResolveProductByCode.mockResolvedValue(widget);
      await openScreen();
      await scanCode("111");
      await screen.findByText("Widget");
      await scanCode("222");
      await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));

      await waitFor(() => expect(screen.getByText("1 item · $9.99")).toBeInTheDocument());
      expect(screen.getByText("Widget")).toBeInTheDocument();
    });

    const caseSoda = {
      notFound: false,
      archived: false,
      // A case-packed product: the line is priced PER CASE (unitPrice x boxes), qty is derived.
      product: {
        id: "prod-b",
        name: "Case Soda",
        pricePerUnit: "24",
        unit: "case",
        unitsPerBox: 6,
      },
    };

    it("a repeat scan of a CASE-PACKED product adds a case and the total moves (it used to bump qty, which pricing ignores for boxed lines)", async () => {
      mockResolveProductByCode.mockResolvedValue(caseSoda);
      await openScreen();

      await scanCode("111");
      await screen.findByText("Case Soda");
      expect(screen.getByText("1 item · $24.00")).toBeInTheDocument();
      await scanCode("222");

      await waitFor(() => expect(screen.getByText("1 item · $48.00")).toBeInTheDocument());
      expect(screen.getAllByText("Case Soda")).toHaveLength(1);
    });

    it("Undo of a repeat scan on a case-packed line takes ONE case back and keeps the line", async () => {
      mockResolveProductByCode.mockResolvedValue(caseSoda);
      await openScreen();
      await scanCode("111");
      await screen.findByText("Case Soda");
      await scanCode("222");
      await waitFor(() => expect(screen.getByText("1 item · $48.00")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));

      await waitFor(() => expect(screen.getByText("1 item · $24.00")).toBeInTheDocument());
      expect(screen.getByText("Case Soda")).toBeInTheDocument();
    });

    it("Undo never deletes a line the operator has since raised - it takes one case back", async () => {
      mockResolveProductByCode.mockResolvedValue(caseSoda);
      await openScreen();
      await scanCode("111"); // this scan CREATED the line
      await screen.findByText("Case Soda");
      // The operator raises it to 3 cases by hand.
      fireEvent.change(screen.getByTitle("Number of whole cases"), { target: { value: "3" } });
      await waitFor(() => expect(screen.getByText("1 item · $72.00")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));

      await waitFor(() => expect(screen.getByText("1 item · $48.00")).toBeInTheDocument());
      expect(screen.getByText("Case Soda")).toBeInTheDocument();
    });

    it("an UNKNOWN code opens create-product with the code as SKU and pauses the screen beneath it", async () => {
      mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false });
      await openScreen();

      await scanCode("999000111222");

      await waitFor(() => expect(capturedInlineCreate?.isOpen).toBe(true));
      expect(capturedInlineCreate?.initialSku).toBe("999000111222");
      expect(cameraEnabled).toBe(false); // camera off while the dialog is up
      expect(screen.getByLabelText("Scan items")).toHaveAttribute("aria-hidden", "true");
    });

    it("no customer chosen: warns that scanned items are at list price", async () => {
      await openScreen();
      expect(screen.getByText(/No customer selected/)).toBeInTheDocument();
    });

    it("closing the order builder tears the screen down; reopening does not land straight in it", async () => {
      const { rerender } = await openScreen();

      rerender(<CreateOrderModal isOpen={false} onClose={jest.fn()} />);
      expect(screen.queryByRole("dialog", { name: "Scan items" })).not.toBeInTheDocument();

      rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(await screen.findByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Scan items" })).not.toBeInTheDocument();
    });
  });

  // Regressions from the lead's review of the scan_v2 change (#977).
  describe("scan_v2 review regressions", () => {
    const boxedProduct = {
      notFound: false,
      archived: false,
      product: {
        id: "prod-b",
        name: "Case Soda",
        pricePerUnit: "24",
        unit: "case",
        unitsPerBox: 6,
      },
    };
    const tiered = {
      notFound: false,
      archived: false,
      product: {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: "10",
        priceTier2: "8",
        priceTier3: "7",
        unit: "each",
      },
    };
    const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 2 };

    const pickCustomer = async (name: string) => {
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: name.slice(0, 3) },
      });
      fireEvent.click(await screen.findByText(name));
    };

    describe("a repeat add on a case-packed line (money)", () => {
      it("flag OFF: the historical +1 unit - a repeat add does NOT add a whole extra case", async () => {
        mockScanV2 = false;
        mockResolveProductByCode.mockResolvedValue(boxedProduct);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

        capturedOnScan!("111");
        expect(await screen.findByText(/6 pcs total/)).toBeInTheDocument();
        capturedOnScan!("111");

        expect(await screen.findByText(/7 pcs total/)).toBeInTheDocument();
        expect(screen.queryByText(/12 pcs total/)).not.toBeInTheDocument();
      });

      it("flag ON: the scan adds a whole case", async () => {
        mockScanV2 = true;
        mockResolveProductByCode.mockResolvedValue(boxedProduct);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

        capturedOnScan!("111");
        expect(await screen.findByText(/6 pcs total/)).toBeInTheDocument();
        capturedOnScan!("111");

        expect(await screen.findByText(/12 pcs total/)).toBeInTheDocument();
      });
    });

    it("the order Dialog returns if the addon resolves away while the scan screen is open", async () => {
      mockScanV2 = true;
      const { rerender } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      act(() => capturedOnOpenContinuous!());
      await screen.findByRole("dialog", { name: "Scan items" });
      expect(screen.queryByRole("dialog", { name: "Create Order" })).not.toBeInTheDocument();

      mockScanV2 = false;
      rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);

      expect(await screen.findByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Scan items" })).not.toBeInTheDocument();
    });

    describe("owner ruling D1 - the customer's price applies to lines scanned BEFORE the customer", () => {
      it("choosing a tier-2 customer afterwards re-prices the scanned line to their tier price", async () => {
        mockScanV2 = true;
        mockCustomers = [acme];
        mockResolveProductByCode.mockResolvedValue(tiered);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        capturedOnScan!("111");
        expect(await screen.findByText("$10.00 / each")).toBeInTheDocument();

        await pickCustomer("Acme Foods");

        expect(await screen.findByText("$8.00 / each")).toBeInTheDocument();
        expect(screen.getByText("Special price")).toBeInTheDocument();
      });

      it("a customer-specific product tier (customer prices) wins over the customer's default tier", async () => {
        mockScanV2 = true;
        mockCustomers = [acme];
        mockCustomerPrices = [{ productId: "prod-1", pricingTier: 3 }];
        mockResolveProductByCode.mockResolvedValue(tiered);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        capturedOnScan!("111");
        await screen.findByText("$10.00 / each");

        await pickCustomer("Acme Foods");

        expect(await screen.findByText("$7.00 / each")).toBeInTheDocument();
      });

      it("an operator's one-time price is NOT overwritten by the customer's tier", async () => {
        mockScanV2 = true;
        mockCustomers = [acme];
        mockResolveProductByCode.mockResolvedValue(tiered);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        capturedOnScan!("111");
        await screen.findByText("$10.00 / each");
        fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "9.00" } });
        expect(await screen.findByText("$9.00 / each")).toBeInTheDocument();

        await pickCustomer("Acme Foods");

        expect(screen.getByText("$9.00 / each")).toBeInTheDocument();
        expect(screen.queryByText("$8.00 / each")).not.toBeInTheDocument();
      });

      it("flag OFF: the classic modal is unchanged - choosing a customer afterwards does NOT re-price", async () => {
        mockScanV2 = false;
        mockCustomers = [acme];
        mockResolveProductByCode.mockResolvedValue(tiered);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        capturedOnScan!("111");
        await screen.findByText("$10.00 / each");

        await pickCustomer("Acme Foods");

        expect(screen.getByText("$10.00 / each")).toBeInTheDocument();
        expect(screen.queryByText("$8.00 / each")).not.toBeInTheDocument();
      });

      it("a line scanned AFTER the customer is chosen is priced for them immediately", async () => {
        mockScanV2 = true;
        mockCustomers = [acme];
        mockResolveProductByCode.mockResolvedValue(tiered);
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await pickCustomer("Acme Foods");

        capturedOnScan!("111");

        expect(await screen.findByText("$8.00 / each")).toBeInTheDocument();
      });
    });
  });
});
