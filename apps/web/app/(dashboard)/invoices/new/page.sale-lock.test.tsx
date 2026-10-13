import * as React from "react";
import userEvent from "@testing-library/user-event";
import { SALE_RECOVERY_COPY as COPY, saleRecoveryBody } from "@routeflow/types/sale-attempt";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
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

const WIDGET = { id: "prod-1", name: "Widget", pricePerUnit: "9.99" };
/** An axios-shaped error: any code (or none), the committed draft's id in the body. */
const sendFailure = (data: Record<string, unknown>) => ({ response: { status: 400, data } });

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
const callOpts = (n: number) =>
  mockCreateSale.mock.calls[n][1] as {
    onSuccess: (r: unknown) => void;
    onError: (e: unknown) => void;
  };
const keyOf = (n: number) =>
  (mockCreateSale.mock.calls[n][0] as { idempotencyKey?: string }).idempotencyKey;

async function ringAndFail(error: unknown) {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: /new sale/i }));
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  await submit(user);
  await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
  act(() => callOpts(0).onError(error));
  await screen.findByTestId("sale-unknown");
  return user;
}
const fiveHundred = { response: { status: 500, data: { statusCode: 500 } } };

describe("row 485 — an unknown New sale outcome locks the cart", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = WIDGET;
    mockApiPost.mockResolvedValue({ data: {} });
  });

  it("after a 5xx the inputs are disabled, an edit is refused and Create sale is off", async () => {
    const user = await ringAndFail(fiveHundred);
    const price = screen.getByLabelText("Unit price") as HTMLInputElement;
    expect(price).toBeDisabled();
    const before = price.value;
    await user.type(price, "9");
    expect(price.value).toBe(before);
    expect(screen.getByRole("button", { name: /create sale & invoice/i })).toBeDisabled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("the panel carries the shared copy", async () => {
    await ringAndFail(fiveHundred);
    const panel = screen.getByTestId("sale-unknown");
    expect(within(panel).getByText(COPY.title)).toBeInTheDocument();
    expect(
      within(panel).getByText(saleRecoveryBody({ invoiceId: null, orderId: null })),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: COPY.tryAgain })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: COPY.startNew })).toBeInTheDocument();
  });

  it.each([
    [{ statusCode: 500 }, "check recent orders."],
    [{ orderId: "ord-1" }, "open the order to check."],
    [{ invoiceId: "inv-1", orderId: "ord-1" }, "open the invoice to check."],
  ])("the body's closing clause follows the action offered (%j)", async (data, tail) => {
    await ringAndFail({ response: { status: 500, data } });
    const panel = screen.getByTestId("sale-unknown");
    expect(panel.textContent).toContain(`Try again to finish it, or ${tail}`);
    // never offers to open something that does not exist
    if (!("orderId" in data) && !("invoiceId" in data)) {
      expect(panel.textContent).not.toMatch(/open the (order|invoice)/);
    }
  });

  it("the locked form LOOKS locked: the disabled fieldset is dimmed and not-allowed; the panel is not dimmed", async () => {
    await ringAndFail(fiveHundred);
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset).toBeDisabled();
    expect(fieldset.className).toContain("opacity-[0.45]");
    expect(fieldset.className).toContain("cursor-not-allowed");
    expect(fieldset.contains(screen.getByTestId("sale-unknown"))).toBe(false);
    expect(screen.getByTestId("sale-unknown").className).not.toContain("opacity");
  });

  it("an unlocked form is not dimmed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset.className).not.toContain("opacity-[0.45]");
  });

  it("the clerk SEES it: the panel is scrolled into view and focus lands on Try again", async () => {
    const scroll = jest.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    try {
      await ringAndFail(fiveHundred);
      expect(scroll).toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: COPY.tryAgain }));
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("Try again resends the SAME body under the SAME key", async () => {
    const user = await ringAndFail(fiveHundred);
    await user.click(screen.getByRole("button", { name: COPY.tryAgain }));
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBeTruthy();
    expect(keyOf(1)).toBe(keyOf(0));
    expect(mockCreateSale.mock.calls[1][0]).toEqual(mockCreateSale.mock.calls[0][0]);
  });

  it.each([
    [
      "orderId",
      { code: "SALE_INVOICE_CREATE_FAILED", orderId: "ord-1" },
      COPY.openOrder,
      "/orders/ord-1",
    ],
    [
      "invoiceId",
      { invoiceId: "inv-1", orderId: "ord-1", message: "raw" },
      COPY.openInvoice,
      "/invoices/inv-1",
    ],
    ["no id", { statusCode: 500 }, COPY.recentOrders, "/orders"],
  ])("a body with %s offers the right way to look", async (_n, data, label, href) => {
    await ringAndFail({ response: { status: 500, data } });
    const panel = screen.getByTestId("sale-unknown");
    expect(within(panel).getByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(panel.textContent).not.toContain("raw");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Start a new sale needs a confirm that points at recent orders; Keep leaves it locked", async () => {
    const user = await ringAndFail(fiveHundred);
    await user.click(screen.getByRole("button", { name: COPY.startNew }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(COPY.confirmBody)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: COPY.recentOrders })).toHaveAttribute(
      "href",
      "/orders",
    );
    await user.click(within(dialog).getByRole("button", { name: COPY.confirmKeep }));
    expect(screen.getByLabelText("Unit price")).toBeDisabled();
    expect(screen.getByTestId("sale-unknown")).toBeInTheDocument();
  });

  it("confirming Start a new sale unlocks, clears the key, and the next submit has a NEW key", async () => {
    const user = await ringAndFail(fiveHundred);
    await user.click(screen.getByRole("button", { name: COPY.startNew }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: COPY.startNew }));
    await waitFor(() => expect(screen.queryByTestId("sale-unknown")).toBeNull());
    expect(screen.getByLabelText("Unit price")).toBeEnabled();
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBeTruthy();
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("control: a definitive refusal with no committed sale does NOT lock", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    await user.click(screen.getByPlaceholderText(/search customers/i));
    await user.click(await screen.findByText("Acme Co"));
    capturedOnScan!("012345678905");
    await screen.findByDisplayValue("Widget");
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
    act(() =>
      callOpts(0).onError({ response: { status: 400, data: { message: "Customer not found" } } }),
    );
    expect(screen.queryByTestId("sale-unknown")).toBeNull();
    expect(screen.getByLabelText("Unit price")).toBeEnabled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not create the sale", variant: "error" }),
    );
  });
});
