import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { InlineReturnSection } from "./InlineReturnSection";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// W-711 (F22, F23): a return line is named by its product on the quote step, and the optional
// per-line extras sit behind "More". Same mocking convention as InlineReturnSection.test.tsx.
const mockEntryOrder = {
  orderNumber: "ORD-7",
  orderDate: "2026-10-01T12:00:00.000Z",
  lineItems: [],
};
jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? mockEntryOrder : undefined }),
}));

const PRODUCT = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [PRODUCT] } }),
}));

const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));

let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
}));

function chunk(overrides: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: "order-newest",
    sourceInvoiceItemId: "inv-item-1",
    sourceOrderItemId: "order-item-1",
    productId: "prod-1",
    pieces: 10,
    subtotal: 20,
    taxAmount: 2,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 2,
    ...overrides,
  };
}

function quoteResponse(chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: 20,
    taxAmount: 2,
    categoryTax: 0,
    total: 22,
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  authRole = undefined;
});

async function addWidget() {
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByText("Widget"));
}

describe("InlineReturnSection — returns say what happens (W-711)", () => {
  it("F22: the quote step names each line by its product, with the order as secondary text", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => quoteMutate.mock.calls[0][1].onSuccess(quoteResponse([chunk()])));

    const row = (await screen.findByText(/from order #ORD-7/i)).closest("div.rounded-lg");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Widget");
    const title = within(row as HTMLElement).getByText("Widget");
    expect(title).toBeInTheDocument();
    // the product comes first, the order reference is the quieter line after it
    expect(
      title.compareDocumentPosition(within(row as HTMLElement).getByText(/from order #ORD-7/i)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("F23: Reason and Note sit behind a per-line More; the quantity stays visible", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    expect(screen.getByLabelText(/^pieces$/i)).toBeVisible();
    expect(screen.getByLabelText(/note \(optional\)/i)).not.toBeVisible();
    expect(screen.getByLabelText(/reason \(optional\)/i)).not.toBeVisible();

    const more = screen.getByRole("button", { name: "More for Widget" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/note \(optional\)/i)).toBeVisible();
    expect(screen.getByLabelText(/reason \(optional\)/i)).toBeVisible();
  });

  it("More accessibility: aria-controls points at a real element, mounted while collapsed", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    const more = screen.getByRole("button", { name: "More for Widget" });
    const panel = document.getElementById(more.getAttribute("aria-controls") as string);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("hidden");
    fireEvent.click(more);
    expect(panel).not.toHaveAttribute("hidden");
  });

  it("More collapses back (label Less) while every field is empty", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    fireEvent.click(screen.getByRole("button", { name: "More for Widget" }));
    const less = screen.getByRole("button", { name: "Less for Widget" });
    expect(less).toHaveTextContent("Less");
    expect(less).toBeEnabled();
    fireEvent.click(less);
    expect(screen.getByLabelText(/note \(optional\)/i)).not.toBeVisible();
    expect(screen.getByRole("button", { name: "More for Widget" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("More is not a dead button: while a field holds a value the toggle is disabled and says Less", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    fireEvent.click(screen.getByRole("button", { name: "More for Widget" }));
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), { target: { value: "dented" } });
    const less = screen.getByRole("button", { name: "Less for Widget" });
    expect(less).toBeDisabled();
    expect(screen.getByLabelText(/note \(optional\)/i)).toBeVisible();
    // clearing the value frees it again
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Less for Widget" })).toBeEnabled();
  });

  it("a DRIVER (or no role) opening More never sees the staff Credit price field", async () => {
    for (const role of ["DRIVER", undefined]) {
      authRole = role;
      const { unmount } = renderWithProviders(<InlineReturnSection customerId="cust-1" />);
      await addWidget();
      fireEvent.click(screen.getByRole("button", { name: "More for Widget" }));
      expect(screen.getByLabelText(/note \(optional\)/i)).toBeVisible();
      expect(screen.queryByLabelText(/credit price/i)).toBeNull();
      expect(screen.queryByLabelText(/why the lower price/i)).toBeNull();
      unmount();
    }
  });

  it("F23: a line that holds a note opens its More by itself and keeps the value", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), { target: { value: "dented" } });
    // a fresh re-mount of the row (Remove then Undo) restores the line with the note showing
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(screen.getByRole("button", { name: /less/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/note \(optional\)/i)).toBeVisible();
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue("dented");
  });

  it("F23: the staff credit price is behind More too, and opens itself once it has a value", async () => {
    authRole = "OPERATOR";
    renderWithProviders(<InlineReturnSection customerId="cust-1" />);
    await addWidget();
    expect(screen.getByLabelText(/credit price/i)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "1.50" } });
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(screen.getByLabelText(/credit price/i)).toBeVisible();
    expect(screen.getByLabelText(/credit price/i)).toHaveValue("1.50");
    expect(screen.getByLabelText(/why the lower price/i)).toBeVisible();
  });
});
