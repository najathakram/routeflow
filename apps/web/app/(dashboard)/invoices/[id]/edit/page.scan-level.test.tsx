import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * #2717 M4a-1 / SA-595c (1): the invoice EDIT screen's row scanner resolves the scanned code's
 * LEVEL like the order screens. A distinct UNIT code puts ONE loose piece on the row; a distinct
 * BOX code puts a whole case (qty = pack); a SHARED code is a picker tap (the row's qty is left
 * alone); a upb <= 1 product keeps today's line. Sent as the boxed split, so nothing is hidden.
 */

const updateMutate = jest.fn();
let mockBarcodeProduct: Record<string, unknown> | undefined;
let capturedOnScan: ((code: string) => void) | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({
    data: {
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "c1",
      status: "DRAFT",
      issueDate: "2026-09-20T00:00:00.000Z",
      discount: 0,
      shippingFee: 0,
      items: [
        {
          id: "li-1",
          productId: "p0",
          description: "Old",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          taxRate: 0,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateInvoice: () => ({ mutate: updateMutate, mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: undefined, isLoading: false }),
  useCustomerPrices: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string) =>
      url.startsWith("/products/barcode/") && mockBarcodeProduct
        ? Promise.resolve({ data: mockBarcodeProduct })
        : Promise.reject(new Error("not found")),
    ),
    post: jest.fn(),
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));

const BOXED = { id: "p-24", name: "Case Soda", pricePerUnit: "60", unitsPerBox: 24 };

async function scanAndSave(code: string) {
  renderWithProviders(<EditInvoicePage />);
  await screen.findByDisplayValue("Old");
  await act(async () => {
    capturedOnScan!(code);
  });
  await screen.findByDisplayValue("Case Soda");
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  await waitFor(() => expect(updateMutate).toHaveBeenCalled());
  return (updateMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = undefined;
  mockBarcodeProduct = undefined;
});

describe("SA-595c (1) — invoice edit scan applies the scanned level", () => {
  it("a distinct UNIT code puts ONE loose piece on the row", async () => {
    mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["UNIT"] } };
    expect(await scanAndSave("2000000000012")).toMatchObject({ qty: 1, boxes: 0, pieces: 1 });
  });

  it("a UNIT code with no scanMatch falls back to the product's unitSku column", async () => {
    mockBarcodeProduct = { ...BOXED, unitSku: "2000000000012" };
    expect(await scanAndSave("2000000000012")).toMatchObject({ qty: 1, boxes: 0, pieces: 1 });
  });

  it("a distinct BOX code puts a whole case on the row", async () => {
    mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX"] } };
    expect(await scanAndSave("COLA-24")).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
  });

  it("a SHARED code equals a picker tap: the row's qty is left alone", async () => {
    mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX", "UNIT"] } };
    expect(await scanAndSave("4000000000019")).toMatchObject({ qty: 5, boxes: 0, pieces: 5 });
  });

  it("upb <= 1: a UNIT code keeps today's line (qty untouched, no split)", async () => {
    mockBarcodeProduct = {
      id: "p-1",
      name: "Case Soda",
      pricePerUnit: "9.99",
      unitsPerBox: 1,
      scanMatch: { levels: ["UNIT"] },
    };
    const item = await scanAndSave("1");
    expect(item.qty).toBe(5);
    expect(item.boxes).toBeUndefined();
  });
});
