import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, act } from "@/test-utils/render";
import EditInvoicePage from "./page";

/** Row 510: saving an invoice DRAFT is judged; a 409 RESTRICTION_WARNING opens the dialog and the save is re-sent with the ack. */
const updateMutate = jest.fn();
const toast = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
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
          productId: "p1",
          description: "Widget",
          qty: 2,
          unitPrice: 10,
          subtotal: 20,
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "l:li-1",
          productId: "p1",
          displayName: "Widget",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    },
  },
};

describe("invoice edit page: row 510 warning", () => {
  beforeEach(() => jest.clearAllMocks());

  it("warns, then re-sends the same save with the ack and raises no failure toast", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditInvoicePage />);
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    const first = updateMutate.mock.calls[0][0];
    act(() => updateMutate.mock.calls[0][1].onError(warning409));
    await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    expect(updateMutate).toHaveBeenCalledTimes(2);
    expect(updateMutate.mock.calls[1][0]).toEqual({
      ...first,
      restrictionOverrides: [{ lineKey: "l:li-1", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    expect(toast).not.toHaveBeenCalled();
  });
});
