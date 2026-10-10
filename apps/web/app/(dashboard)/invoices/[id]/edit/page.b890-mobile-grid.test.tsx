import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * B890 — the web invoice-edit line grid at 390px. Each line row was a fixed six-column grid
 * (1fr + 70/90/70/70/32px ≈ 428px of track) inside an overflow-x-hidden main ~294px wide: the
 * description collapsed and the Tax % cell + delete button were clipped and unreachable. The fix
 * keeps that grid for sm+ only; below sm a line wraps (description + delete, then Qty / Unit Price /
 * Disc. $ / Tax % with their own labels, since the header row is sm+ only). jsdom has no layout, so
 * this pins the STRUCTURE; the executed 390/768/1440 proof is the Playwright capture in the PR.
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

const line = (id: string, description: string) => ({
  id,
  productId: "p1",
  description,
  qty: 2,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 10,
  discount: 0,
  taxRate: 0.1,
  subtotal: 20,
});
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
const WIDE = "grid-cols-[1fr_70px_90px_70px_70px_32px]";

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoice = draft([line("li-1", "Widget"), line("li-2", "Gadget")]);
});

describe("B890 invoice edit line grid — reachable at 390px", () => {
  it("every line's delete button is a named control ('Remove line')", () => {
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getAllByRole("button", { name: "Remove line" })).toHaveLength(2);
  });

  it("every line's Tax % input carries its own label (the header row is sm+ only)", () => {
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getAllByLabelText("Tax %")).toHaveLength(2);
  });

  it("the six fixed columns apply from sm up only; below sm the row uses a layout that fits", () => {
    renderWithProviders(<EditInvoicePage />);
    const row = screen.getAllByRole("button", { name: "Remove line" })[0].closest(".grid")!;
    const classes = row.className.split(/\s+/);
    expect(classes).toContain(`sm:${WIDE}`);
    expect(classes).not.toContain(WIDE); // never the fixed grid at the base (390px) width
  });
});
