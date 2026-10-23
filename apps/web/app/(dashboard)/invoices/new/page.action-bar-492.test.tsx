import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import NewInvoicePage from "./page";

/**
 * Row 492 — the invoice form's fixed bottom action bar overflowed at 390 px and clipped
 * "Save and Send". jsdom has no layout, so this pins the contract that keeps every control
 * reachable: the bar wraps, nothing is removed, and each action is a 44 px target.
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

const mockPost = jest.fn((url: string) => Promise.resolve({ data: { url } }));
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

const CONTROLS = [/^preview$/i, /^download$/i, /^save as draft$/i, /save and send/i, /^cancel$/i];

describe("row 492 — invoice action bar at phone width", () => {
  async function bar() {
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(
      screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
    );
    return screen.getByTestId("invoice-action-bar");
  }

  it("wraps instead of overflowing, and keeps every control inside the bar", async () => {
    const el = await bar();
    expect(el.firstElementChild?.className).toContain("flex-wrap");
    for (const name of CONTROLS) {
      const control = screen.getByRole("button", { name });
      expect(el.contains(control)).toBe(true);
    }
  });

  it("gives Save as draft and Save and Send 44 px targets", async () => {
    await bar();
    for (const name of [/^save as draft$/i, /save and send/i, /^preview$/i, /^download$/i]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/min-h-\[?(11|44px)\]?/);
    }
    expect(screen.getByRole("button", { name: /^cancel$/i }).className).toMatch(
      /min-h-\[?(11|44px)\]?/,
    );
  });
});
