import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 510 on the New invoice page: a staff create (the "Other charge" invoice and the New sale / counter-style
 * "Create sale & invoice") the API answers with 409 RESTRICTION_WARNING opens the warning dialog, and "Sell anyway"
 * re-sends the SAME payload plus the per-line reasons and the hash.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Co" }] } }),
  useCustomerPrices: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string) =>
      Promise.resolve({
        data: url.startsWith("/products/barcode/")
          ? { id: "prod-1", name: "Widget", pricePerUnit: "9.99" }
          : {},
      }),
    ),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const createMutate = jest.fn();
const saleMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: createMutate, mutateAsync: jest.fn(), isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: saleMutate, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
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

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
          productId: "prod-1",
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
const ack = {
  restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
  warningHash: "rw1:abc",
};

async function openForm(basis: RegExp) {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: basis }));
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  return user;
}
async function sellAnyway(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByText("This product is banned in CA by law.")).toBeInTheDocument();
  await user.type(screen.getByLabelText(/reason/i), "Owner approved");
  await user.click(screen.getByRole("button", { name: "Sell anyway" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = undefined;
});

describe("row 510 - New invoice page", () => {
  it("an invoice create (Other charge, Save and send) warns, then re-sends the same payload plus the ack", async () => {
    const user = await openForm(/other charge/i);
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const first = createMutate.mock.calls[0][0];
    act(() => createMutate.mock.calls[0][1].onError(warning409));
    await sellAnyway(user);
    expect(createMutate).toHaveBeenCalledTimes(2);
    expect(createMutate.mock.calls[1][0]).toEqual({ ...first, ...ack });
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });

  it("the New sale create warns, then re-sends the same sale plus the ack", async () => {
    const user = await openForm(/new sale/i);
    await user.click(screen.getByRole("button", { name: /create sale|save draft invoice/i }));
    await waitFor(() => expect(saleMutate).toHaveBeenCalledTimes(1));
    const first = saleMutate.mock.calls[0][0];
    act(() => saleMutate.mock.calls[0][1].onError(warning409));
    await sellAnyway(user);
    expect(saleMutate).toHaveBeenCalledTimes(2);
    expect(saleMutate.mock.calls[1][0]).toEqual({ ...first, ...ack });
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });

  it("Go back sends nothing more and raises no error toast", async () => {
    const user = await openForm(/other charge/i);
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    act(() => createMutate.mock.calls[0][1].onError(warning409));
    await user.click(await screen.findByRole("button", { name: "Go back" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });
});
