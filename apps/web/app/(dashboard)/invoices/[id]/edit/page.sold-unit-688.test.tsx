import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * Row 688 (SA-827 §1/§4/P7): the edit form edits the STORED line in its sold unit. A boxed line used to
 * open as one "Qty" field holding total pieces (48.000) beside the per-BOX unit price ($21.60): two units
 * side by side. It now opens as boxes + loose pieces at the line's own stored pack, and saves exactly the
 * stored-unit fields (qty in pieces, boxes, pieces, the box price, the stored pack), whether or not the
 * line has a productId.
 */

let mockInvoice: Record<string, unknown> | undefined;
const updateMutate = jest.fn();

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

const boxedLine = (extra: Record<string, unknown> = {}) => ({
  id: "li-1",
  productId: "p-oj",
  description: "Orange juice 12oz",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 21.6,
  taxRate: 0,
  discount: 0,
  ...extra,
});

const draft = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-10-21T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items,
  ...extra,
});

const subtotal = (): HTMLElement => {
  const el = screen.getAllByText("Subtotal").find((n) => n.tagName === "DT");
  if (!el) throw new Error('no summary row "Subtotal"');
  return el.parentElement as HTMLElement;
};

async function save() {
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  expect(updateMutate).toHaveBeenCalledTimes(1);
  return updateMutate.mock.calls[0][0].items[0];
}

beforeEach(() => updateMutate.mockReset());

describe("row 688: invoice edit form edits a boxed line in its sold unit", () => {
  it("opens a 2-box line as 2 boxes + 0 pieces at the box price, never a 48 pieces qty", () => {
    mockInvoice = draft([boxedLine()]);
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getByLabelText("Boxes")).toHaveValue("2");
    expect(screen.getByLabelText("Pieces")).toHaveValue("0");
    expect(screen.queryByLabelText("Qty")).toBeNull();
    expect(screen.getByLabelText("Unit Price")).toHaveValue("21.60");
    expect(subtotal()).toHaveTextContent("$43.20");
  });

  it("saving it unchanged posts the identical stored row", async () => {
    mockInvoice = draft([boxedLine()]);
    renderWithProviders(<EditInvoicePage />);
    const line = await save();
    expect(line).toMatchObject({ qty: 48, boxes: 2, pieces: 0, unitPrice: 21.6 });
  });

  it("a boxed line with no productId still posts its split (never a bare 48 x $21.60)", async () => {
    mockInvoice = draft([boxedLine({ productId: null })]);
    renderWithProviders(<EditInvoicePage />);
    const line = await save();
    expect(line).toMatchObject({ qty: 48, boxes: 2, pieces: 0, unitPrice: 21.6 });
  });

  it("3 boxes saves qty 72 and totals $64.80", async () => {
    mockInvoice = draft([boxedLine()]);
    renderWithProviders(<EditInvoicePage />);
    const boxes = screen.getByLabelText("Boxes");
    await userEvent.clear(boxes);
    await userEvent.type(boxes, "3");
    expect(subtotal()).toHaveTextContent("$64.80");
    const line = await save();
    expect(line).toMatchObject({ qty: 72, boxes: 3, pieces: 0, unitPrice: 21.6 });
  });

  it("50 loose pieces normalise to 2 boxes + 2 pieces, prorated", async () => {
    mockInvoice = draft([boxedLine()]);
    renderWithProviders(<EditInvoicePage />);
    const boxes = screen.getByLabelText("Boxes");
    const pieces = screen.getByLabelText("Pieces");
    await userEvent.clear(boxes);
    await userEvent.type(boxes, "0");
    await userEvent.clear(pieces);
    await userEvent.type(pieces, "50");
    // 21.60 x (2 + 2/24) = 45.00
    expect(subtotal()).toHaveTextContent("$45.00");
    const line = await save();
    expect(line).toMatchObject({ qty: 50, boxes: 2, pieces: 2, unitPrice: 21.6 });
  });
});
