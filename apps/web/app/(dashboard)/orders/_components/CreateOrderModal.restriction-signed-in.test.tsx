import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act, fireEvent, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { createMemoryDraftStorage, setDraftMirrorStorage } from "@/lib/order-draft/storage";

// Row 510: a SIGNED-IN staff user has an autosave mirror, so the submit first awaits durableBeforeSubmit() before the POST.
// "Sell anyway" must still land its ack on that POST (the hook used to clear the ack before the await resolved).

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
const product = (id: string) => ({
  notFound: false,
  archived: false,
  product: { id, name: `Widget ${id}`, pricePerUnit: "9.99", unit: "each" },
});
const NEVER = () => new Promise(() => undefined);
const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
          productId: "p1",
          displayName: "Widget p1",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "Restricted in CA: State ban.",
            },
          ],
        },
      ],
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: "u1", tenantId: "t1", role: "OPERATOR" };
  mockServerDrafts = [];
  mockLoadedDraft = undefined;
  mockProductNow = {};
  setDraftMirrorStorage(createMemoryDraftStorage());
  mockCreateDraft.mockImplementation(() => NEVER());
  mockUpdateDraft.mockImplementation(() => NEVER());
});
afterEach(() => setDraftMirrorStorage(null));

describe("CreateOrderModal - Sell anyway on a signed-in session (row 510)", () => {
  it("the re-send, which waits on the durable mirror write, still carries the ack", async () => {
    const user = userEvent.setup();
    mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }];
    mockResolveProductByCode.mockResolvedValue(product("p1"));
    post.mockRejectedValueOnce(warning409).mockResolvedValue({ data: { id: "o1" } });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    capturedOnScan!("111");
    await screen.findByText("Widget p1");

    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    const dialog = await screen.findByRole("dialog", { name: /sell a restricted product/i });
    await user.type(within(dialog).getByLabelText(/reason/i), "Owner approved");
    await user.click(within(dialog).getByRole("button", { name: "Sell anyway" }));

    await waitFor(() => expect(orderPosts()).toHaveLength(2), { timeout: 4000 });
    expect(orderPosts()[1][1]).toMatchObject({
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    await act(async () => undefined);
  });
});
