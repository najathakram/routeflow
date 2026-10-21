import * as React from "react";
import { renderWithProviders, screen, waitFor, act, fireEvent, cleanup } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { createMemoryDraftStorage, setDraftMirrorStorage } from "@/lib/order-draft/storage";
import { readDraftSubmitKey } from "@routeflow/types/draft-submit-key";

// Row 604 F15 / row 699b: the footer's dismiss says Close (it parks the order as a draft), the toast says
// "Draft saved" and offers Discard. Harness: CreateOrderModal.draft-resume.test.tsx.

window.HTMLElement.prototype.scrollIntoView = jest.fn();

let mockUser: Record<string, unknown> | null = { id: "u1", tenantId: "t1", role: "OPERATOR" };
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), user: mockUser }) };
});

let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: (customerId?: string) => ({ data: customerId ? [] : [] }),
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

const mockCreateDraft = jest.fn();
const mockUpdateDraft = jest.fn();
const mockDeleteDraft = jest.fn();
let mockLoadedDraft: unknown = undefined;
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({
    mutate: jest.fn(),
    mutateAsync: (...a: unknown[]) => mockCreateDraft(...a),
    isPending: false,
  }),
  useUpdateDraft: () => ({
    mutate: jest.fn(),
    mutateAsync: (...a: unknown[]) => mockUpdateDraft(...a),
    isPending: false,
  }),
  useDeleteDraft: () => ({ mutate: (...a: unknown[]) => mockDeleteDraft(...a) }),
  useDraft: () => ({ data: mockLoadedDraft, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

let mockServerDrafts: unknown[] = [];
// GET /products/:id - today's tier columns per product; null = the read fails (offline).
let mockProductNow: Record<string, Record<string, unknown>> | null = {};
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string) => {
      const m = /^\/products\/([^/]+)$/.exec(url);
      if (m) {
        const row = mockProductNow?.[m[1]];
        return row ? Promise.resolve({ data: row }) : Promise.reject(new Error("Network Error"));
      }
      return Promise.resolve({ data: url === "/drafts" ? mockServerDrafts : { taxRate: 0 } });
    }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = props.onScan;
    return (
      <button type="button" title={props.title} aria-label={props.title}>
        {props.title}
      </button>
    );
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => false,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: () => ({
    videoRef: { current: null },
    torchAvailable: false,
    torchOn: false,
    toggleTorch: jest.fn(),
    refocus: jest.fn(),
    error: null,
  }),
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
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
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

import { apiClient } from "@/lib/api-client";

const post = apiClient.post as jest.Mock;
const orderPosts = () => post.mock.calls.filter((c) => c[0] === "/orders");
const keyOf = (i: number) => orderPosts()[i][2]?.headers?.["Idempotency-Key"] as string;
const bodyOf = (i: number) => orderPosts()[i][1] as { items: Array<Record<string, unknown>> };
const product = (id: string) => ({
  notFound: false,
  archived: false,
  product: { id, name: `Widget ${id}`, pricePerUnit: "9.99", unit: "each" },
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
const createBtn = () => screen.getByRole("button", { name: /^create order$/i });
const NEVER = () => new Promise(() => undefined);
const PREFIX = "rf:draft:t1:u1:";

let storage: ReturnType<typeof createMemoryDraftStorage>;

async function pickCustomerAndScan(code = "111", id = "p1") {
  mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }];
  mockResolveProductByCode.mockResolvedValue(product(id));
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  capturedOnScan!(code);
  await screen.findByText(`Widget ${id}`);
}

const localRecords = () => storage.list(PREFIX);
const waitForLocalCopy = () =>
  waitFor(async () => expect(await localRecords()).toHaveLength(1), { timeout: 4000 });

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: "u1", tenantId: "t1", role: "OPERATOR" };
  mockServerDrafts = [];
  mockLoadedDraft = undefined;
  mockProductNow = {};
  storage = createMemoryDraftStorage();
  setDraftMirrorStorage(storage);
  mockCreateDraft.mockImplementation(() => NEVER()); // the server is unreachable unless a test says otherwise
  mockUpdateDraft.mockImplementation(() => NEVER());
});
afterEach(() => setDraftMirrorStorage(null));

describe("CreateOrderModal - Close parks a draft and offers Discard (F15 / row 699b)", () => {
  it("the dismiss button says Close, not Cancel", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.getByText("Close", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByText("Cancel", { selector: "button" })).toBeNull();
  });

  it("Close with a parkable order toasts 'Draft saved' with a Discard action that deletes that draft", async () => {
    mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
    const onClose = jest.fn();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await pickCustomerAndScan();
    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    fireEvent.click(screen.getByText("Close", { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = mockToast.mock.calls.map((c) => c[0]).find((t) => /draft saved/i.test(t.title));
    expect(saved).toBeDefined();
    expect(saved.action?.label).toBe("Discard");
    act(() => saved.action.onClick());
    // Row 604 S5: a confirm step, as the drafts dock has, before anything is deleted.
    expect(mockDeleteDraft).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^discard$/i }));
    expect(mockDeleteDraft).toHaveBeenCalledWith("d1", expect.anything());
  });

  it("Close that itself creates the draft still offers Discard (row 604 S5)", async () => {
    mockCreateDraft.mockResolvedValue({ id: "d9", updatedAt: "2026-10-19T10:00:00.000Z" });
    const onClose = jest.fn();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await pickCustomerAndScan();
    // No wait for autosave: the draft row does not exist until Close flushes it.
    expect(mockCreateDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Close", { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = mockToast.mock.calls.map((c) => c[0]).find((t) => /draft saved/i.test(t.title));
    expect(saved.action?.label).toBe("Discard");
  });

  it("Close on an empty order closes at once with no toast", async () => {
    const onClose = jest.fn();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("Close", { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockToast).not.toHaveBeenCalled();
  });
});
