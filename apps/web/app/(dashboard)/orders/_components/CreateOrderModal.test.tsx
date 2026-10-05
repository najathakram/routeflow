import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act, fireEvent, within } from "@/test-utils/render";
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
// Mutable so a test can put the mutation in its error state (the modal's inline API-error banner).
let mockCreateOrderError: unknown = null;
// Mutable so a test can put a customer in the picker / give them per-product tier prices.
let mockCustomers: Array<Record<string, unknown>> = [];
let mockCustomerPrices: Array<Record<string, unknown>> = [];
const mockActiveOrderHook = jest.fn((..._args: unknown[]) => ({ data: undefined }));
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
    error: mockCreateOrderError,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: (...args: unknown[]) => mockActiveOrderHook(...args),
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
  useOrderUiV2: () => ({ enabled: false, resolved: true }), // order_ui_v2 has its own file (add-line)
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

// units_v1: the flag and the product's ladder, mutable per test (default: flag OFF = today's modal).
let mockUnitsEnabled = false;
let mockProductUnits: unknown[] = [];
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockUnitsEnabled,
  useProductUnits: (_id: string, enabled: boolean) => ({
    data: enabled ? mockProductUnits : undefined,
  }),
}));
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

// SA-090f (#1271) pin: scheduleScannerRefocus runs in EVERY addLineItem post-commit tail
// (unlike the toast, which is skipped on the scan screen) — the one call a test can force to
// throw there without needing a real DOM focus target.
const mockScheduleScannerRefocus = jest.fn();
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: (...args: unknown[]) => mockScheduleScannerRefocus(...args),
  isTextEntryActive: () => false,
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
    mockUnitsEnabled = false;
    mockProductUnits = [];
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
          description: "Check the connection and rescan.",
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
    // Steady-read is DEFAULT ON (owner ruling 2026-09-24): one deliberate scan = the same code held for three frames.
    const scanCode = async (code: string) => {
      await act(async () => {
        cameraDetect!(code);
        cameraDetect!(code);
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

    describe("poor-signal queue (step 7)", () => {
      const networkError = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

      it("a scan that fails for lack of signal is queued OFF the order - never a line, never toasted", async () => {
        mockResolveProductByCode.mockRejectedValue(networkError());
        await openScreen();

        await scanCode("012345678905");

        expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent(
          "012345678905",
        );
        expect(screen.getByText("0 items · $0.00")).toBeInTheDocument();
        expect(screen.queryByText("Widget")).not.toBeInTheDocument();
        // The screen is quiet: it reports through its own pill, not a toast per failure.
        expect(mockToast).not.toHaveBeenCalled();
      });

      it("Retry now adds the line once the network is back, through the same resolver", async () => {
        mockResolveProductByCode.mockRejectedValueOnce(networkError());
        mockResolveProductByCode.mockResolvedValue(widget);
        await openScreen();
        await scanCode("012345678905");
        await screen.findByLabelText("Waiting for signal");

        fireEvent.click(screen.getByRole("button", { name: "Retry now" }));

        expect(await screen.findByText("Widget", {}, { timeout: 4000 })).toBeInTheDocument();
        expect(screen.getByText("1 item · $9.99")).toBeInTheDocument();
        expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      });

      it("two queued scans of the SAME product retry into ONE line with qty 2 - never two rows", async () => {
        // Both original lookups fail for lack of signal, then the network returns. The modal decides
        // add-vs-increment from the render it last saw, so retries must run one at a time with a
        // commit in between, or both would read an empty list and add a duplicate row.
        mockResolveProductByCode.mockRejectedValueOnce(networkError());
        mockResolveProductByCode.mockRejectedValueOnce(networkError());
        mockResolveProductByCode.mockResolvedValue(widget);
        await openScreen();
        await scanCode("111");
        await scanCode("222");
        expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent("(2)");

        await act(async () => {
          window.dispatchEvent(new Event("online"));
        });

        await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument(), {
          timeout: 4000,
        });
        expect(screen.getAllByText("Widget")).toHaveLength(1);
        expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      });

      // #1271 merge combined pin (#1261 per-line notes + SA-090/Opus item 1's flushSync merge
      // path): a live scan lands the line first, the operator notes it, THEN a retry of the same
      // product merges in. The note lives on the LineItem object every merge path (mergeQtyIntoLine
      // / stepLineUnit / the plain qty+1 fallback) reaches only via `{ ...li, ... }` — never
      // reconstructed from scratch — so it must survive a post-note merge exactly as this proves.
      it("a retry merging into a noted line keeps the note - one row, note intact", async () => {
        mockResolveProductByCode.mockResolvedValueOnce(widget); // "111" live scan lands it
        mockResolveProductByCode.mockRejectedValueOnce(networkError()); // "222" queues
        mockResolveProductByCode.mockResolvedValueOnce(widget); // "222"'s retry
        await openScreen();
        await scanCode("111");
        await screen.findByText("Widget");

        fireEvent.click(screen.getByTitle("Add flavor / note"));
        fireEvent.change(
          screen.getByPlaceholderText("Flavor or note for this item (prints on invoice)"),
          { target: { value: "Extra cold, please" } },
        );

        await scanCode("222");
        expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent("(1)");

        await act(async () => {
          window.dispatchEvent(new Event("online"));
        });

        await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument(), {
          timeout: 4000,
        });
        expect(screen.getAllByText("Widget")).toHaveLength(1);
        expect(screen.getByDisplayValue("Extra cold, please")).toBeInTheDocument();
      });

      // SA-090f (#1271, red pin a): addLineItem's post-commit tail must never let a throw escape
      // back to the caller — that throw used to be caught by ScanOrderScreen's retryOne as
      // "offline" and re-queued, and the RETRY of the resolver added the line again. The toast
      // itself is skipped on the scan screen (its own running rows would be buried by one per
      // repeat scan), so scheduleScannerRefocus — the one tail call that fires unconditionally —
      // is what this pins throwing. Fake timers, scoped to this one test: the bug's own re-queue
      // schedules its next attempt ~10s out (backoffMs(2)), which real timers and a short waitFor
      // cannot observe — the first version of this pin passed green against the unfixed code for
      // exactly that reason (confirmed by reverting the fix and re-running it before this rewrite).
      it("SA-090f: a post-commit throw on a retry's merge still lands exactly one row, never re-queued", async () => {
        jest.useFakeTimers();
        try {
          mockResolveProductByCode.mockResolvedValueOnce(widget); // "111" live scan creates the line
          mockResolveProductByCode.mockRejectedValueOnce(networkError()); // "222" (same product) queues
          mockResolveProductByCode.mockResolvedValueOnce(widget); // "222"'s retry — merges
          // scheduleScannerRefocus's 1st call is "111"'s own (create-branch) tail — must stay a
          // no-op so the throw lands on the 2nd call, "222"'s retry (merge-branch) tail.
          mockScheduleScannerRefocus.mockImplementationOnce(() => {});
          mockScheduleScannerRefocus.mockImplementationOnce(() => {
            throw new Error("refocus boom");
          });
          await openScreen();
          await scanCode("111");
          await screen.findByText("Widget");

          await scanCode("222");
          expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent("(1)");

          await act(async () => {
            window.dispatchEvent(new Event("online"));
          });

          // The merge landed (qty 2) despite the post-commit throw, and nothing re-queued it.
          await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument());
          expect(screen.getAllByText("Widget")).toHaveLength(1);
          expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();

          // Advance well past the bug's own ~10s re-queue backoff — if it wrongly re-queued, a
          // second retry would be due and calls would climb to 3; a real fix has nothing left to
          // retry, so this changes nothing.
          await act(async () => {
            await jest.advanceTimersByTimeAsync(20_000);
          });

          // Exactly TWO lookups for "222" — the original (queued) live attempt plus ONE retry —
          // never a THIRD, which would be the double-add this pin closes.
          expect(mockResolveProductByCode.mock.calls.filter((c) => c[0] === "222")).toHaveLength(2);
          expect(screen.getAllByText("Widget")).toHaveLength(1);
        } finally {
          jest.useRealTimers();
        }
      });

      it("SA-090/Opus item 1 REG: a LIVE scan racing an in-flight retry of the SAME product lands ONE row at qty 2, never two", async () => {
        // The bug: `addLineItem` decided add-vs-merge from `lineItems` captured in the render the
        // CALL started in, not the render current when it actually commits. A retry's lookup
        // starts, then — before it resolves — a LIVE scan of the same product resolves and reads
        // "not present yet" (true, at that moment) and appends a new row via the unconditional
        // spread. When the retry's own held lookup finally resolves, IT also decided
        // "not present yet" from the SAME stale snapshot and would append a SECOND row for the
        // same product — this is the exact race, proven here with a real, held Promise, not a
        // same-tick ref a synchronous test can't make stale.
        let releaseRetry!: (v: Awaited<ReturnType<typeof mockResolveProductByCode>>) => void;
        const held = new Promise<Awaited<ReturnType<typeof mockResolveProductByCode>>>(
          (r) => (releaseRetry = r),
        );
        mockResolveProductByCode.mockRejectedValueOnce(networkError()); // "111" queues
        mockResolveProductByCode.mockReturnValueOnce(held); // its retry hangs
        await openScreen();
        await scanCode("111");
        expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent("(1)");

        await act(async () => {
          window.dispatchEvent(new Event("online")); // retry starts, now in flight (held)
        });

        // A LIVE scan of the SAME product resolves normally WHILE the retry above is still out.
        mockResolveProductByCode.mockResolvedValueOnce(widget);
        await scanCode("222");
        await waitFor(() => expect(screen.getByText("1 item · $9.99")).toBeInTheDocument());
        expect(screen.getAllByText("Widget")).toHaveLength(1);

        // Now the retry's own held lookup finally resolves.
        await act(async () => releaseRetry(widget));

        await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument(), {
          timeout: 4000,
        });
        // The real assertion: ONE row, at qty 2 — never two separate "Widget" rows.
        expect(screen.getAllByText("Widget")).toHaveLength(1);
      });

      it("SA-090 REG: a Discard tap during an in-flight retry can never orphan the resolver's own add — the line still lands, undoable", async () => {
        // The REAL resolver (CreateOrderModal's addLineItem) adds the line as a side effect of
        // resolving — it does this whether or not the operator still wants the outcome. Before
        // the fix, "still queued?" was checked only AFTER the lookup, so a Discard tap landing in
        // the gap made retryOne walk away from a line the resolver had already added: no history
        // entry, nothing Undo could reach — a phantom line on the order. The item is claimed out
        // of the queue the instant its lookup starts now, so the Discard button for it is simply
        // gone by the time an operator could tap it during that window; if a tap could still race
        // it, the resolver's add must land anyway.
        let releaseRetry!: (v: Awaited<ReturnType<typeof mockResolveProductByCode>>) => void;
        const held = new Promise<Awaited<ReturnType<typeof mockResolveProductByCode>>>(
          (r) => (releaseRetry = r),
        );
        mockResolveProductByCode.mockRejectedValueOnce(networkError());
        mockResolveProductByCode.mockReturnValueOnce(held);
        await openScreen();
        await scanCode("111");
        expect(await screen.findByLabelText("Waiting for signal")).toHaveTextContent("(1)");

        await act(async () => {
          window.dispatchEvent(new Event("online")); // retry starts, now in flight (held) — claimed
        });
        // Claimed out of the queue the moment the lookup started: nothing left to discard.
        expect(screen.queryByRole("button", { name: "Discard 111" })).not.toBeInTheDocument();

        await act(async () => releaseRetry(widget));

        // The line lands — never silently orphaned.
        await waitFor(() => expect(screen.getByText("1 item · $9.99")).toBeInTheDocument());
        expect(screen.getByText("Widget")).toBeInTheDocument();
      });

      it("a real HTTP failure (server answered) is not queued", async () => {
        mockResolveProductByCode.mockRejectedValue(
          Object.assign(new Error("boom"), {
            response: { status: 500, data: { message: "boom" } },
          }),
        );
        await openScreen();

        await scanCode("012345678905");

        expect(await screen.findByText("Couldn't look up that code")).toBeInTheDocument();
        expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      });
    });

    describe("price editor (step 6)", () => {
      const openEditor = async () => {
        mockResolveProductByCode.mockResolvedValue(widget);
        await openScreen();
        await scanCode("012345678905");
        await screen.findByText("Widget");
        fireEvent.click(screen.getByText("$9.99 / each"));
        return screen.findByRole("dialog", { name: "Edit Widget" });
      };

      it("tapping a scanned row's price opens the sheet for that line", async () => {
        const editor = await openEditor();
        expect(editor).toBeInTheDocument();
      });

      it("setting a one-time price re-prices the line and the pinned total, through the row's own handler", async () => {
        await openEditor();

        fireEvent.change(screen.getByLabelText("Price"), { target: { value: "8.50" } });

        await waitFor(() => expect(screen.getByText("1 item · $8.50")).toBeInTheDocument());
      });

      it("stepping the quantity from the sheet updates the same line", async () => {
        await openEditor();

        fireEvent.click(screen.getByLabelText("One more"));

        await waitFor(() => expect(screen.getByText("1 item · $19.98")).toBeInTheDocument());
      });

      it("Escape closes the sheet but leaves the scan screen (and the order) open", async () => {
        await openEditor();

        fireEvent.keyDown(document.body, { key: "Escape" });

        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: "Edit Widget" })).not.toBeInTheDocument(),
        );
        expect(screen.getByRole("dialog", { name: "Scan items" })).toBeInTheDocument();
        expect(screen.getByText("Widget")).toBeInTheDocument();
      });

      it("Done in the sheet returns to the scan screen with the edit applied", async () => {
        await openEditor();
        fireEvent.change(screen.getByLabelText("Price"), { target: { value: "8.50" } });

        fireEvent.click(
          within(screen.getByRole("dialog", { name: "Edit Widget" })).getByRole("button", {
            name: "Done",
          }),
        );

        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: "Edit Widget" })).not.toBeInTheDocument(),
        );
        expect(screen.getByText("1 item · $8.50")).toBeInTheDocument();
      });
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
        // #2696 (b): the price is changed by tapping it — the sheet owns the one-time price.
        fireEvent.click(screen.getAllByLabelText("Change price")[0]);
        const sheet = await screen.findByRole("dialog", { name: /^edit /i });
        fireEvent.change(within(sheet).getByPlaceholderText("10.00"), {
          target: { value: "9.00" },
        });
        fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
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

    describe("selling restrictions - the API's SELLING_RESTRICTED 409 is shown as a blocked-items dialog", () => {
      const restricted409 = {
        response: {
          status: 409,
          data: {
            code: "SELLING_RESTRICTED",
            blockedLines: [
              {
                productId: "p1",
                productName: "Hemp Gummies",
                categoryName: "Hemp",
                ruleId: "r1",
                reason: "STATE_BAN",
                state: "TX",
                message: "m",
              },
            ],
          },
        },
      };

      afterEach(() => {
        mockCreateOrderError = null;
      });

      // NOTE: a real *draft* is not blocked by the API (only non-draft sales are checked; the block
      // lands at promotion), so the 409 is injected into the shared onError here. That handler is
      // the one every create/promote path goes through; the real-server behaviour is F2's proof.
      it("a blocked save opens the dialog with the item and a plain cause, and raises NO page-level toast", async () => {
        mockCustomers = [acme];
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await pickCustomer("Acme Foods");
        fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
        expect(createOrderMutate).toHaveBeenCalledTimes(1);

        createOrderMutate.mock.calls[0][1].onError(restricted409);

        const dialog = await screen.findByRole("dialog", {
          name: /can't be sold to this customer/i,
        });
        expect(within(dialog).getByText("Hemp Gummies")).toBeInTheDocument();
        expect(within(dialog).getByText("Restricted in TX")).toBeInTheDocument();
        expect(within(dialog).queryByText("p1")).toBeNull(); // never a raw id
        expect(mockToast).not.toHaveBeenCalled();
      });

      it("shows no inline red banner for it (the dialog is the one message; the rule reason stays out)", async () => {
        mockCustomers = [acme];
        mockCreateOrderError = {
          ...restricted409,
          message: "Request failed",
          response: {
            ...restricted409.response,
            data: { ...restricted409.response.data, message: "Restricted: internal rule reason" },
          },
        };
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await pickCustomer("Acme Foods");
        expect(screen.queryByText(/internal rule reason/)).toBeNull();
        expect(screen.queryByText(/Request failed/)).toBeNull();
      });

      it("any other API error still shows the inline banner", async () => {
        mockCustomers = [acme];
        mockCreateOrderError = { response: { status: 500, data: { message: "Boom happened" } } };
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await pickCustomer("Acme Foods");
        // an UNCODED refusal keeps today's server sentence (B986-7 Opus: never a vaguer fallback)
        expect(screen.getByText("Boom happened")).toBeInTheDocument();
      });

      // CREDIT_LIMIT_EXCEEDED is in providers.tsx's HANDLED_CODES (the order detail opens a guard
      // dialog), which silences the global toast — so the create modal's inline banner is the ONLY
      // place its message can show. This pins that a credit refusal on create is never silent.
      it("a credit-limit refusal on create shows the FIXED sentence built from the structured numbers in the banner (B986)", async () => {
        mockCustomers = [acme];
        mockCreateOrderError = {
          response: {
            status: 409,
            data: {
              code: "CREDIT_LIMIT_EXCEEDED",
              limit: 100,
              exposure: 110,
              message: "Over their credit limit of 100.00.",
            },
          },
        };
        renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await pickCustomer("Acme Foods");
        expect(
          screen.getByText(/over their \$100\.00 credit limit. Collect a payment/),
        ).toBeInTheDocument();
        expect(screen.queryByText("Over their credit limit of 100.00.")).not.toBeInTheDocument();
      });
    });
  });
  describe("units_v1 - selling an order line by a unit", () => {
    const caseLevel = {
      id: "u1",
      label: "Case",
      factorToBase: 288,
      price: "480.00",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      isDefaultSelling: false,
      sortOrder: 0,
    };
    const boxed = {
      notFound: false,
      archived: false,
      product: { id: "prod-1", name: "Widget", pricePerUnit: "42", unit: "Box", unitsPerBox: 24 },
    };
    const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };

    const setup = async () => {
      mockUnitsEnabled = true;
      mockProductUnits = [caseLevel];
      mockCustomers = [cust];
      mockResolveProductByCode.mockResolvedValue(boxed);
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Acm" },
      });
      fireEvent.click(await screen.findByText("Acme Foods"));
      capturedOnScan!("111");
      return screen.findByLabelText("Sell Widget by");
    };
    const saveDraft = () => {
      fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
      expect(createOrderMutate).toHaveBeenCalledTimes(1);
      return createOrderMutate.mock.calls[0][0].items;
    };

    it("a line sold by the Case is sent as { productId, qty: count, unitLabel } — no boxes, pieces or price", async () => {
      fireEvent.change(await setup(), { target: { value: "Case" } });
      expect(await screen.findByText("$480.00 / Case")).toBeInTheDocument();
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 1, unitLabel: "Case" }]);
    });

    it("choosing the pack again restores the case-packed line exactly (no unitLabel)", async () => {
      const select = await setup();
      fireEvent.change(select, { target: { value: "Case" } });
      fireEvent.change(await screen.findByLabelText("Sell Widget by"), { target: { value: "" } });
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 24, boxes: 1, pieces: 0 }]);
    });

    it("re-key: product + unit is the line's identity — a scan after switching to Case adds a PACK line, not +1 Case", async () => {
      fireEvent.change(await setup(), { target: { value: "Case" } });
      await screen.findByText("$480.00 / Case");
      capturedOnScan!("111");
      await waitFor(() => expect(screen.getAllByLabelText("Sell Widget by")).toHaveLength(2));
      expect(saveDraft()).toEqual([
        { productId: "prod-1", qty: 1, unitLabel: "Case" },
        { productId: "prod-1", qty: 24, boxes: 1, pieces: 0 },
      ]);
    });

    it("re-key: switching the pack line to a Case that already exists folds the two into one line", async () => {
      fireEvent.change(await setup(), { target: { value: "Case" } });
      await screen.findByText("$480.00 / Case");
      capturedOnScan!("111");
      await waitFor(() => expect(screen.getAllByLabelText("Sell Widget by")).toHaveLength(2));
      fireEvent.change(screen.getAllByLabelText("Sell Widget by")[1], {
        target: { value: "Case" },
      });
      await waitFor(() => expect(screen.getAllByLabelText("Sell Widget by")).toHaveLength(1));
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 2, unitLabel: "Case" }]);
    });

    it("without flag.units_v1 there is no picker and no unitLabel — today's modal", async () => {
      mockCustomers = [cust];
      mockResolveProductByCode.mockResolvedValue(boxed);
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Acm" },
      });
      fireEvent.click(await screen.findByText("Acme Foods"));
      capturedOnScan!("111");
      await screen.findByText(/24 pcs total/);
      expect(screen.queryByLabelText("Sell Widget by")).toBeNull();
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 24, boxes: 1, pieces: 0 }]);
    });
  });

  // #2696 (owner): tap-to-edit price/qty on the line, the case/unit toggle sells ONE unit with loose
  // units opt-in, and the payload shape is unchanged ({qty, boxes, pieces}).
  describe("#2696 order line editing", () => {
    const cust = (tier = 1) => ({ id: "c1", businessName: "Acme Foods", pricingTier: tier });
    const boxed = {
      notFound: false,
      archived: false,
      product: { id: "prod-1", name: "Widget", pricePerUnit: "42", unit: "Box", unitsPerBox: 24 },
    };
    const plain = {
      notFound: false,
      archived: false,
      product: { id: "prod-2", name: "Soda", pricePerUnit: "2.50", unit: "each" },
    };
    const setup = async (resolved: unknown, tier = 1) => {
      mockCustomers = [cust(tier)];
      mockResolveProductByCode.mockResolvedValue(resolved);
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Acm" },
      });
      fireEvent.click(await screen.findByText("Acme Foods"));
      await act(async () => {
        capturedOnScan!("111");
      });
    };
    const saveDraft = () => {
      fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
      expect(createOrderMutate).toHaveBeenCalledTimes(1);
      return createOrderMutate.mock.calls[0][0].items;
    };

    it("(d) a new case-packed line shows ONLY the cases field and submits pieces = 0", async () => {
      await setup(boxed);
      expect(await screen.findByTitle("Number of whole cases")).toBeInTheDocument();
      expect(screen.queryByLabelText("Extra loose units")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "+ units" })).toBeInTheDocument();
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 24, boxes: 1, pieces: 0 }]);
    });

    it("(d) “+ units” reveals the loose field; its value rides as pieces on top of the cases", async () => {
      await setup(boxed);
      fireEvent.click(await screen.findByRole("button", { name: "+ units" }));
      fireEvent.change(screen.getByLabelText("Extra loose units"), { target: { value: "5" } });
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 29, boxes: 1, pieces: 5 }]);
    });

    it("(d) removing the extra units puts pieces back to 0 and hides the field", async () => {
      await setup(boxed);
      fireEvent.click(await screen.findByRole("button", { name: "+ units" }));
      fireEvent.change(screen.getByLabelText("Extra loose units"), { target: { value: "5" } });
      fireEvent.click(screen.getByRole("button", { name: "Remove extra units" }));
      expect(screen.queryByLabelText("Extra loose units")).not.toBeInTheDocument();
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 24, boxes: 1, pieces: 0 }]);
    });

    it("(d) Unit mode shows only the total units; back in Case mode a loose remainder is shown, never dropped", async () => {
      await setup(boxed);
      fireEvent.click(await screen.findByRole("button", { name: "Unit" }));
      const total = screen.getByTitle("Total units") as HTMLInputElement;
      expect(total.value).toBe("24"); // 1 case → 24 units: the same qty, converted by display
      expect(screen.queryByTitle("Number of whole cases")).not.toBeInTheDocument();
      fireEvent.change(total, { target: { value: "25" } });
      fireEvent.click(screen.getByRole("button", { name: "Case" }));
      expect((screen.getByTitle("Number of whole cases") as HTMLInputElement).value).toBe("1");
      expect((screen.getByLabelText("Extra loose units") as HTMLInputElement).value).toBe("1");
      expect(saveDraft()).toEqual([{ productId: "prod-1", qty: 25, boxes: 1, pieces: 1 }]);
    });

    it("(b) a plain line's qty is tap-to-type; below 1 clamps to 1", async () => {
      await setup(plain);
      const qty = (await screen.findByLabelText("Quantity")) as HTMLInputElement;
      // #2865 case c: a freshly added line is PENDING (qty locked) until its default unit resolves.
      await waitFor(() => expect(qty).toBeEnabled());
      fireEvent.change(qty, { target: { value: "7" } });
      expect(qty.value).toBe("7");
      fireEvent.change(qty, { target: { value: "0" } });
      expect(qty.value).toBe("1");
      // A cleared field (and non-numeric input, which a number field reports as "") never NaNs.
      fireEvent.change(qty, { target: { value: "7" } });
      fireEvent.change(qty, { target: { value: "" } });
      expect(qty.value).toBe("1");
      fireEvent.change(qty, { target: { value: "abc" } });
      expect(qty.value).toBe("1");
      fireEvent.change(qty, { target: { value: "7" } });
      expect(saveDraft()).toEqual([{ productId: "prod-2", qty: 7 }]);
    });

    it("(b) tapping a line's price opens its price/qty sheet; closing it returns to the list", async () => {
      await setup(plain);
      const tap = await screen.findByLabelText("Change price");
      // The list row carries no inline price box — the price is changed by tapping it (owner).
      expect(screen.queryByText("Price:")).not.toBeInTheDocument();
      fireEvent.click(tap);
      // The modal itself is a dialog; the price sheet is the one named "Edit <product>".
      expect(await screen.findByRole("dialog", { name: /^edit /i })).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("button", { name: /close price editor/i })[0]);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /^edit /i })).not.toBeInTheDocument(),
      );
      // Escape closes only the sheet; the order builder stays open.
      fireEvent.click(screen.getByLabelText("Change price"));
      const sheet = await screen.findByRole("dialog", { name: /^edit /i });
      fireEvent.keyDown(sheet, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /^edit /i })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
    });

    // #2696(c) (SA-558/558a): a SPECIAL line's price is tappable too; moving it off the special price
    // needs a reason, decided by @routeflow/pricing's decideStaffOverride — the server's own rule.
    const special = {
      notFound: false,
      archived: false,
      product: {
        id: "prod-2",
        name: "Soda",
        pricePerUnit: "2.50",
        priceTier2: "2.00",
        unit: "each",
      },
    };
    const openSheet = async () => {
      expect(await screen.findByText("Special price")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Change price"));
      return screen.findByRole("dialog", { name: /^edit /i });
    };
    const typePrice = (sheet: HTMLElement, v: string) => {
      const input = within(sheet).getByLabelText("Price");
      fireEvent.change(input, { target: { value: v } });
      fireEvent.blur(input);
    };

    it("(c) a SPECIAL-priced line's price opens the sheet, the special price as its placeholder", async () => {
      await setup(special, 2);
      const sheet = await openSheet();
      expect(within(sheet).getByLabelText("Price")).toHaveAttribute("placeholder", "2.00");
      expect(within(sheet).getByText(/special price \$2\.00/i)).toBeInTheDocument();
    });

    it("(c) moving off the special price with no reason blocks saving, naming the product", async () => {
      await setup(special, 2);
      typePrice(await openSheet(), "1.50");
      expect(screen.getByLabelText("Reason (required)")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
      expect(createOrderMutate).not.toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/reason is required to change Soda/),
        }),
      );
    });

    it("(c) with a reason the override is sent: unitPrice + overrideReason", async () => {
      await setup(special, 2);
      typePrice(await openSheet(), "1.50");
      fireEvent.change(screen.getByLabelText("Reason (required)"), {
        target: { value: "dented cans" },
      });
      expect(saveDraft()).toEqual([
        { productId: "prod-2", qty: 1, unitPrice: 1.5, overrideReason: "dented cans" },
      ]);
    });

    it("(c) typing the LIST price on a special line is a real change too — it needs a reason", async () => {
      await setup(special, 2);
      typePrice(await openSheet(), "2.50");
      expect(screen.getByLabelText("Reason (required)")).toBeInTheDocument();
    });

    it("(c) typing the special price back restores it: no reason, nothing overridden", async () => {
      await setup(special, 2);
      const sheet = await openSheet();
      typePrice(sheet, "1.50");
      typePrice(sheet, "2.00");
      expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
      expect(saveDraft()).toEqual([{ productId: "prod-2", qty: 1 }]);
    });
  });

  it("M4: the active-order preview asks for the SAME path create will use (the customer's SHIP default)", async () => {
    mockCustomers = [
      { id: "c-ship", businessName: "Shipco Ltd", pricingTier: 1, fulfillPath: "SHIP" },
    ];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Shi" },
    });
    fireEvent.click(await screen.findByText("Shipco Ltd"));
    await waitFor(() => expect(mockActiveOrderHook).toHaveBeenLastCalledWith("c-ship", "SHIP"));
  });
});
