import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * units_v1 FAIL-CLOSED guard on the invoice edit form (B641). update() refuses a unit line (4c-2 is not
 * built) and this form holds no unit state, so opening a draft that holds a line sold by a unit and
 * saving it would silently store a PACK line: 3 Cases (864 pieces) -> 72 pieces, money unchanged.
 * The page must REFUSE VISIBLY — say why and what to do — and never offer a save.
 */

const updateMutate = jest.fn();
const updateMutateAsync = jest.fn();
let mockInvoice: Record<string, unknown> | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: false,
  }),
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

const packLine = {
  id: "li-1",
  productId: "p1",
  description: "Widget",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 42,
  subtotal: 84,
};
const caseLine = {
  id: "li-2",
  productId: "p1",
  description: "Widget",
  qty: 864,
  boxes: 3,
  pieces: 0,
  unitsPerBox: 288,
  unitLabel: "Case",
  unitPrice: 480,
  subtotal: 1440,
};
const draft = (items: unknown[]) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoice = undefined;
});

describe("invoice edit page — a draft holding a unit line", () => {
  it("refuses visibly: names the unit and what to do, offers a way back, and NO save", () => {
    mockInvoice = draft([packLine, caseLine]);
    renderWithProviders(<EditInvoicePage />);

    expect(screen.getByText(/sold by the Case and can.t be edited here yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/turn that line into a pack line and change its quantity/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/delete this draft and create it again/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to invoice/i })).toHaveAttribute(
      "href",
      "/invoices/inv-1",
    );
    // no form at all: nothing to save, so nothing can convert the line
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    expect(screen.queryByText("Line Items")).toBeNull();
    expect(updateMutate).not.toHaveBeenCalled();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("names every distinct unit on the invoice", () => {
    mockInvoice = draft([caseLine, { ...caseLine, id: "li-3", unitLabel: "Pallet" }]);
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getByText(/sold by the Case \/ Pallet/i)).toBeInTheDocument();
  });
});

describe("invoice edit page — FLAG-OFF characterization: a pack-only draft edits exactly as before", () => {
  it("renders the edit form (Line Items, Save Changes) and no unit refusal", () => {
    mockInvoice = draft([packLine]);
    renderWithProviders(<EditInvoicePage />);

    expect(screen.getByText("Line Items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.queryByText(/can.t be edited here yet/i)).toBeNull();
  });

  it("a line with a blank/null unitLabel is a pack line, not a refusal", () => {
    mockInvoice = draft([
      { ...packLine, unitLabel: null },
      { ...packLine, id: "li-4", unitLabel: "" },
    ]);
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });
});
