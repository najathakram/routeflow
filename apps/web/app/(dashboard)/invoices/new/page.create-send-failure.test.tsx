import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 448 (create path) — with no preview draft, "Save and Send" posts the create with send:true.
 * The API commits the DRAFT then sends; a delivery failure answers EMAIL_SEND_FAILED + the draft's
 * invoiceId. The page must say saved-not-sent and open that draft (never "Failed to create invoice",
 * which invites a retry that duplicates it). Any other create error keeps the plain failure toast.
 */

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Co" }] } }),
  useCustomerPrices: () => ({ data: [] }),
}));

const mockPost = jest.fn(() => Promise.resolve({ data: {} }));
const mockGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return Promise.resolve({
      data: { id: "prod-1", name: "Widget", pricePerUnit: "9.99" },
    });
  }
  if (url.endsWith("/pdf")) return Promise.resolve({ data: {} });
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockGet(url),
    post: () => mockPost(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

let mockCreateError: unknown;
const createMutate = jest.fn((_v: unknown, o: { onError?: (e: unknown) => unknown }) =>
  o.onError?.(mockCreateError),
);
const updateInvoiceMutate = jest.fn((_vars: unknown, opts: { onSuccess?: () => unknown }) =>
  opts.onSuccess?.(),
);
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({
    mutate: (v: unknown, o: { onError?: (e: unknown) => unknown }) => createMutate(v, o),
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useUpdateInvoice: () => ({
    mutate: (v: unknown, o: { onSuccess?: () => unknown }) => updateInvoiceMutate(v, o),
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: jest.fn(), isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

async function saveAndSendWithoutPreview() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  await user.click(screen.getByRole("button", { name: /save and send/i }));
}

const apiError = (data: unknown) => ({ response: { status: 400, data } });

describe("row 448 — create path: send failed after the draft was created", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
  });

  it("EMAIL_SEND_FAILED + invoiceId: saved-not-sent warning, routes to the draft, no failure toast", async () => {
    mockCreateError = apiError({
      code: "EMAIL_SEND_FAILED",
      invoiceId: "inv-kept",
      message: "SMTP exploded: secret-server-detail",
    });
    await saveAndSendWithoutPreview();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/invoices/inv-kept"));
    const toasts = mockToast.mock.calls.map((c) => c[0]);
    expect(toasts.map((t) => t.title)).not.toContain("Failed to create invoice");
    const notSent = toasts.find((t) => /not sent/i.test(t.title));
    expect(notSent).toBeDefined();
    expect(notSent.variant).toBe("warning");
    expect(JSON.stringify(notSent)).not.toMatch(/SMTP|secret-server-detail/);
  });

  it("EMAIL_SEND_FAILED without invoiceId (older API): plain failure toast, no navigation", async () => {
    mockCreateError = apiError({ code: "EMAIL_SEND_FAILED" });
    await saveAndSendWithoutPreview();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to create invoice" }),
      ),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("control: any other create error still shows 'Failed to create invoice'", async () => {
    mockCreateError = apiError({ code: "VALIDATION_FAILED", invoiceId: "inv-x" });
    await saveAndSendWithoutPreview();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to create invoice", variant: "error" }),
      ),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});
