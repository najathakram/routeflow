import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 448 — "Save and Send" on a form that already has a preview draft updates the draft and then
 * POSTs /invoices/:id/send. The send's failure was swallowed by an empty catch and the page still
 * toasted "Invoice sent", falsely claiming delivery. A failed send must say the invoice was saved
 * as a draft but NOT sent (fixed copy only — never the server text), then still open the invoice.
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

let mockSendResult: "ok" | "fail" = "ok";
const mockPost = jest.fn((url: string) =>
  url.endsWith("/send") && mockSendResult === "fail"
    ? Promise.reject(new Error("SMTP exploded: secret-server-detail"))
    : Promise.resolve({ data: {} }),
);
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
    post: (url: string) => mockPost(url),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const updateInvoiceMutate = jest.fn((_vars: unknown, opts: { onSuccess?: () => unknown }) =>
  opts.onSuccess?.(),
);
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn().mockResolvedValue({ id: "draft-1" }),
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

async function previewThenSaveAndSend() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  // Preview creates the draft (sets currentDraftId).
  await user.click(screen.getByRole("button", { name: /^preview$/i }));
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/invoices/draft-1/pdf"));
  await user.click(screen.getByRole("button", { name: /save and send/i }));
}

describe("row 448 — Save and Send on an existing preview draft", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockSendResult = "ok";
  });

  it("REPRO: a failed /send never toasts 'Invoice sent'; says saved-not-sent and still opens the invoice", async () => {
    mockSendResult = "fail";
    await previewThenSaveAndSend();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/invoices/draft-1"));
    const titles = mockToast.mock.calls.map((c) => c[0].title);
    expect(titles).not.toContain("Invoice sent");
    const notSent = mockToast.mock.calls.map((c) => c[0]).find((t) => /not sent/i.test(t.title));
    expect(notSent).toBeDefined();
    expect(notSent.variant).not.toBe("success");
    expect(JSON.stringify(notSent)).not.toMatch(/SMTP|secret-server-detail/);
  });

  it("control: a successful /send toasts 'Invoice sent' and opens the invoice", async () => {
    await previewThenSaveAndSend();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/invoices/draft-1"));
    expect(mockPost).toHaveBeenCalledWith("/invoices/draft-1/send");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Invoice sent", variant: "success" }),
    );
  });
});
