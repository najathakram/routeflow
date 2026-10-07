import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * B1215 C7 on the invoice EDIT screen: the row's product search never offers a FAMILY as a line.
 * A family's variants stand in for it, named "<Parent> - <Variant>", and the picked row carries
 * that composed description.
 */

const updateMutate = jest.fn();

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
const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  pricePerUnit: "4.00",
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  pricePerUnit: "0",
  variants: [MINT],
};
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [FAMILY] } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(() => Promise.reject(new Error("not found"))),
    post: jest.fn(),
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  pricePerUnit: "4.00",
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  pricePerUnit: "0",
  variants: [MINT],
};
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [FAMILY] } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(() => Promise.reject(new Error("not found"))),
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("invoice edit product search (B1215 C7)", () => {
  it("offers the variant under the parent name and never the family", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditInvoicePage />);
    const input = await screen.findByDisplayValue("Old");
    await user.clear(input);
    await user.type(input, "pod");
    const option = await screen.findByRole("button", { name: /Sample Pod - Mint/ });
    expect(screen.queryByRole("button", { name: /^Sample Pod(?! -)/ })).not.toBeInTheDocument();
    await user.click(option);
    await waitFor(() => expect(screen.getByDisplayValue("Sample Pod - Mint")).toBeInTheDocument());
  });
});
