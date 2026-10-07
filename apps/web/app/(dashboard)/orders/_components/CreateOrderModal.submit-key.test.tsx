import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act, fireEvent, within } from "@/test-utils/render";
import { renderHook } from "@testing-library/react";
import { CreateOrderModal } from "./CreateOrderModal";
import { useCreateOrderSubmitKey } from "./use-create-order-submit-key";

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
  ...jest.requireActual("@/lib/api/orders"),
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

import { apiClient } from "@/lib/api-client";

/**
 * BUG-A: a fast double click on Create Order made two identical orders. The latch + the
 * Idempotency-Key lifecycle (use-create-order-submit-key.ts) are pinned here against the REAL
 * useCreateOrder over a mocked transport (the sibling suites mock the hook with isPending:false,
 * which would make a double click always "double").
 */
const post = apiClient.post as jest.Mock;
const orderPosts = () => post.mock.calls.filter((c) => c[0] === "/orders");
const keyOf = (i: number) => orderPosts()[i][2]?.headers?.["Idempotency-Key"] as string;
const product = (id: string) => ({
  notFound: false,
  archived: false,
  product: { id, name: `Widget ${id}`, pricePerUnit: "9.99", unit: "each" },
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

async function openWithLine() {
  mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 2 }];
  mockResolveProductByCode.mockResolvedValue(product("p1"));
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  capturedOnScan!("111");
  await screen.findByText("Widget p1");
}
const createBtn = () => screen.getByRole("button", { name: /^create order$/i });
async function addAnotherLine() {
  mockResolveProductByCode.mockResolvedValue(product("p2"));
  capturedOnScan!("222");
  await screen.findByText("Widget p2");
}

describe("CreateOrderModal - one order per attempt (BUG-A)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScanV2 = false;
    mockUnitsEnabled = false;
    mockCustomerPrices = [];
  });

  it("a fast double click on Create Order sends exactly ONE POST /orders, with an Idempotency-Key", async () => {
    post.mockImplementation(() => new Promise(() => {})); // never settles: still in flight
    await openWithLine();
    fireEvent.click(createBtn());
    fireEvent.click(createBtn());
    await flush();
    expect(orderPosts()).toHaveLength(1);
    expect(keyOf(0)).toEqual(expect.any(String));
    expect(keyOf(0).length).toBeGreaterThan(8);
    expect(createBtn()).toBeDisabled();
  });

  it("a double click on Save as Draft is latched too", async () => {
    post.mockImplementation(() => new Promise(() => {}));
    await openWithLine();
    const draft = screen.getByRole("button", { name: /save as draft/i });
    fireEvent.click(draft);
    fireEvent.click(draft);
    await flush();
    expect(orderPosts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /save as draft/i })).toBeDisabled();
  });

  it("a retry after a 5xx KEEPS the key (the first attempt may have been written)", async () => {
    post
      .mockRejectedValueOnce({ response: { status: 503, data: {} } })
      .mockResolvedValue({ data: { id: "o1" } });
    await openWithLine();
    fireEvent.click(createBtn());
    await flush();
    await waitFor(() => expect(createBtn()).not.toBeDisabled());
    fireEvent.click(createBtn());
    await flush();
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("an edit after a timeout (no response) KEEPS the key - the server's replay/hash answers", async () => {
    post
      .mockRejectedValueOnce(new Error("timeout of 30000ms exceeded"))
      .mockResolvedValue({ data: { id: "o1" } });
    await openWithLine();
    fireEvent.click(createBtn());
    await flush();
    await waitFor(() => expect(createBtn()).not.toBeDisabled());
    await addAnotherLine();
    fireEvent.click(createBtn());
    await flush();
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("an edit after a 2xx gets a NEW key", async () => {
    post.mockResolvedValue({ data: { id: "o1" } });
    await openWithLine();
    fireEvent.click(createBtn());
    await flush();
    await waitFor(() => expect(createBtn()).not.toBeDisabled());
    await addAnotherLine();
    fireEvent.click(createBtn());
    await flush();
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("a definitive 4xx refusal gets a NEW key on the next attempt, even with the cart unchanged", async () => {
    post
      .mockRejectedValueOnce({ response: { status: 422, data: {} } })
      .mockResolvedValue({ data: { id: "o1" } });
    await openWithLine();
    fireEvent.click(createBtn());
    await flush();
    await waitFor(() => expect(createBtn()).not.toBeDisabled());
    fireEvent.click(createBtn());
    await flush();
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe("CreateOrderModal - the key already made an order (SA-715)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScanV2 = false;
    mockUnitsEnabled = false;
    mockCustomerPrices = [];
  });

  it.each([["IDEMPOTENCY_KEY_CART_MISMATCH"], ["IDEMPOTENCY_KEY_DRAFT_MISMATCH"]])(
    "a %s 409 opens the existing order and NEVER resubmits on a new key",
    async (code) => {
      post.mockRejectedValue({ response: { status: 409, data: { code, orderId: "ord-77" } } });
      const onClose = jest.fn();
      const onViewOrder = jest.fn();
      mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 2 }];
      mockResolveProductByCode.mockResolvedValue(product("p1"));
      renderWithProviders(<CreateOrderModal isOpen onClose={onClose} onViewOrder={onViewOrder} />);
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Acm" },
      });
      fireEvent.click(await screen.findByText("Acme Foods"));
      capturedOnScan!("111");
      await screen.findByText("Widget p1");
      fireEvent.click(createBtn());
      await flush();
      await waitFor(() => expect(onViewOrder).toHaveBeenCalledWith("ord-77"));
      expect(onClose).toHaveBeenCalled();
      expect(orderPosts()).toHaveLength(1); // no re-mint + resubmit
    },
  );
});

describe("useCreateOrderSubmitKey - lifecycle", () => {
  it("a plain cart edit with nothing in flight and no unknown outcome mints a new key", () => {
    const { result } = renderHook(() => useCreateOrderSubmitKey(true));
    const k1 = result.current.begin("cart-A");
    result.current.settle("same-attempt"); // e.g. the merge prompt: nothing written, attempt still open
    expect(result.current.begin("cart-A")).toBe(k1); // same cart, same attempt: same key
    result.current.settle("same-attempt");
    const k2 = result.current.begin("cart-B"); // edited
    expect(k2).not.toBe(k1);
  });

  it("while a request is in flight begin() refuses, whatever the cart", () => {
    const { result } = renderHook(() => useCreateOrderSubmitKey(true));
    expect(result.current.begin("cart-A")).toEqual(expect.any(String));
    expect(result.current.begin("cart-A")).toBeNull();
    expect(result.current.begin("cart-B")).toBeNull();
  });

  it("an unknown outcome keeps the key through an edit until a known outcome", () => {
    const { result } = renderHook(() => useCreateOrderSubmitKey(true));
    const k1 = result.current.begin("cart-A");
    result.current.settle("unknown");
    expect(result.current.begin("cart-B")).toBe(k1);
    result.current.settle("success");
    expect(result.current.begin("cart-B")).not.toBe(k1);
  });
});
