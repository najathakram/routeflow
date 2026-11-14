import * as React from "react";
import userEvent from "@testing-library/user-event";
import { SALE_RECOVERY_COPY as COPY, saleRecoveryBody } from "@routeflow/types/sale-attempt";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
let mockTenantToday: string | undefined;
jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => mockTenantToday,
}));

import NewInvoicePage from "./page";

/**
 * Row 750 (BT-5): the New sale delivery date defaults to, and is labelled from, the TENANT's day (useTenantToday), not the
 * browser's. Harness copied from page.sale-lock.test.tsx.
 * Row 485 — while a New sale's outcome is UNKNOWN (a 5xx, a dropped connection, or any error naming a committed
 * order or invoice) the cart is LOCKED behind a panel: Try again (the SAME key), Open order / Open invoice (or the
 * recent orders), and Start a new sale behind a confirm. A definitive outcome unlocks as before. The copy is the
 * shared SALE_RECOVERY_COPY, pinned here and in the mobile suite.
 */

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
const mockCreateSale = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockApiPost = jest.fn();
const mockApiGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
const createInvoiceMutateAsync = jest.fn();
const updateInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({
    mutate: createInvoiceMutate,
    mutateAsync: createInvoiceMutateAsync,
    isPending: false,
  }),
  useUpdateInvoice: () => ({
    mutate: updateInvoiceMutate,
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: mockCreateSale, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));

jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockApiGet(url),
    post: (...args: unknown[]) => mockApiPost(...args),
    patch: jest.fn(),
    delete: jest.fn(),
  },
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

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

describe("W-1188: the New sale's date is the order-date chip, worded 'Sale date', past-only", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({
      now: new Date("2026-10-25T20:00:00Z"),
      doNotFake: [
        "setTimeout",
        "setInterval",
        "queueMicrotask",
        "nextTick",
        "setImmediate",
        "clearTimeout",
        "clearInterval",
        "clearImmediate",
      ],
    });
    mockCustomers = [];
    mockTenantToday = "2026-10-26";
  });
  afterEach(() => jest.useRealTimers());

  const openSale = async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    return user;
  };
  const dateInputs = () =>
    Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  const dueInput = () => dateInputs().find((i) => i.value === "2026-11-25") as HTMLInputElement;
  const chip = () => screen.getByTestId("counter-date-chip");
  const termsSelect = () =>
    screen
      .getAllByRole("combobox")
      .find((el) => within(el).queryByRole("option", { name: "Net 15" })) as HTMLSelectElement;
  const chipButton = () => screen.getByRole("button", { name: /^Sale date/ });

  it("replaces the date input with a chip named for the sale, on the tenant's Today", async () => {
    await openSale();
    expect(chipButton()).toHaveAccessibleName("Sale date: today. Change");
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    expect(screen.queryByRole("button", { name: /^Order date/ })).toBeNull(); // one word per field
    expect(screen.getByText("Sale date", { selector: "label" })).toBeInTheDocument();
    // delivery and due remain native date inputs; the issue date is no longer one
    await waitFor(() =>
      expect(dateInputs().map((i) => i.value)).toEqual(["2026-10-26", "2026-11-25"]),
    );
  });

  it("picking Yesterday dates the sale and re-anchors the due date exactly like the old input", async () => {
    const user = await openSale();
    fireEvent.change(termsSelect(), { target: { value: "Net 15" } });
    await waitFor(() => expect(dateInputs().map((i) => i.value)).toContain("2026-11-10")); // 10-26 + 15
    await user.click(chipButton());
    const dialog = await screen.findByRole("dialog", { name: "Sale date" });
    await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    expect(chip()).toHaveTextContent("Dated");
    expect(dateInputs().map((i) => i.value)).toContain("2026-11-09"); // 10-25 + 15 days
    expect(dateInputs().map((i) => i.value)).not.toContain("2026-11-10");
  });

  it("a hand-typed due date survives a sale-date change, as before", async () => {
    const user = await openSale();
    fireEvent.change(dueInput(), { target: { value: "2026-12-31" } });
    await user.click(chipButton());
    const dialog = await screen.findByRole("dialog", { name: "Sale date" });
    await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    expect(dateInputs().map((i) => i.value)).toContain("2026-12-31");
  });

  it("a day after the tenant's today is refused in the picker, with the sale's wording", async () => {
    const user = await openSale();
    await user.click(chipButton());
    const dialog = await screen.findByRole("dialog", { name: "Sale date" });
    await user.type(within(dialog).getByLabelText("Type a date"), "2026-10-28{Enter}");
    expect(dialog).toBeInTheDocument(); // not applied
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    expect(within(dialog).getByTestId("counter-date-echo")).toHaveTextContent(
      "A future day? Set the delivery date instead.",
    );
  });

  it("the x returns the sale to Today", async () => {
    const user = await openSale();
    await user.click(chipButton());
    const dialog = await screen.findByRole("dialog", { name: "Sale date" });
    await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    await user.click(screen.getByRole("button", { name: "Clear the sale date, back to today" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "TODAY"));
    expect(dateInputs().map((i) => i.value)).toContain("2026-11-25"); // untouched terms: the due date stays where it was
  });
});
