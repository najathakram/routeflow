import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * H3b — the invoice edit form sends a line's `overrideReason` the way the New-sale builder does: the
 * Reason field shows once a product line's price moves off the price it was offered at, and the trimmed
 * reason rides that line of the PATCH. A line whose price did not move never shows the field and never
 * sends a reason (the server keeps its stored type/reason/author). The server decides whether the move
 * NEEDS a reason (a special price does) and its 400 text reaches the save-error toast.
 */

const updateMutate = jest.fn();
let mockInvoice: Record<string, unknown> | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({ mutate: updateMutate, mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: undefined, isLoading: false }),
  useCustomerPrices: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const line = {
  id: "li-1",
  productId: "p1",
  description: "Widget",
  qty: 3,
  unitPrice: 20,
  subtotal: 60,
};
const draft = {
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items: [line],
};
const sentItem = () =>
  (updateMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoice = draft;
});

describe("invoice edit page — the price-change reason (H3b)", () => {
  it("an untouched price shows no Reason field and a save sends no overrideReason", async () => {
    renderWithProviders(<EditInvoicePage />);
    expect(screen.queryByLabelText("Reason for the price change")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(sentItem()).toMatchObject({ id: "li-1", unitPrice: 20 });
    expect(sentItem()).not.toHaveProperty("overrideReason");
  });

  it("moving the price shows the Reason field; the trimmed reason rides that line", async () => {
    renderWithProviders(<EditInvoicePage />);
    const price = screen.getByLabelText("Unit Price");
    await userEvent.clear(price);
    await userEvent.type(price, "24");
    await userEvent.type(screen.getByLabelText("Reason for the price change"), "  agreed at list ");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(sentItem()).toMatchObject({
      id: "li-1",
      unitPrice: 24,
      overrideReason: "agreed at list",
    });
  });

  it("a moved price with no reason typed sends none (the server answers with its own 400)", async () => {
    renderWithProviders(<EditInvoicePage />);
    const price = screen.getByLabelText("Unit Price");
    await userEvent.clear(price);
    await userEvent.type(price, "24");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(sentItem()).toMatchObject({ unitPrice: 24 });
    expect(sentItem()).not.toHaveProperty("overrideReason");
  });

  it("moving the price back hides the field and drops the stale reason", async () => {
    renderWithProviders(<EditInvoicePage />);
    const price = screen.getByLabelText("Unit Price");
    await userEvent.clear(price);
    await userEvent.type(price, "24");
    await userEvent.type(screen.getByLabelText("Reason for the price change"), "stale");
    await userEvent.clear(price);
    await userEvent.type(price, "20");
    expect(screen.queryByLabelText("Reason for the price change")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(sentItem()).toMatchObject({ unitPrice: 20 });
    expect(sentItem()).not.toHaveProperty("overrideReason");
  });

  it("the server's reason-required 400 reaches the save-error toast", async () => {
    updateMutate.mockImplementation((_dto: unknown, handlers: { onError: (e: unknown) => void }) =>
      handlers.onError({
        response: {
          data: {
            message: "A reason is required to change Widget — it's this customer's special price",
          },
        },
      }),
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(screen.getByText(/A reason is required to change Widget/)).toBeInTheDocument();
  });
});
