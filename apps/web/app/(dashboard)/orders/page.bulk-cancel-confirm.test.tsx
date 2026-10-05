import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import OrdersPage from "./page";

// REG-B2 (bulk cancel): the selection bar's "Cancel N" fired `updateStatus({status:"CANCELLED"})`
// for every selected order the instant it was clicked — and cancelling an order voids its linked
// invoices (the single-order page puts a cancel-impact confirm in front of exactly this). The bulk
// path had no confirmation at all. These pin: the click only OPENS a confirm (stating the count and
// the void consequence), nothing is cancelled until it is confirmed, and backing out cancels nothing.

const mutateAsync = jest.fn().mockResolvedValue({});

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));

const orderRow = (id: string, n: number) => ({
  id,
  orderNumber: `ORD-${n}`,
  status: "PENDING",
  urgent: false,
  total: 100,
  createdAt: "2026-10-01T00:00:00.000Z",
  requestedDeliveryDate: null,
  customer: { businessName: `Acme ${n}` },
  lineItems: [],
});

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: {
      data: [orderRow("o1", 1), orderRow("o2", 2)],
      meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutateAsync, mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));

function selectAllAndClickBulkCancel() {
  renderWithProviders(<OrdersPage />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  // The filter bar's select-all checkbox is the first checkbox on the page.
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel 2" }));
}

describe("OrdersPage — bulk Cancel confirmation (REG-B2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clicking bulk Cancel opens a confirm and does NOT call the cancel mutation", () => {
    selectAllAndClickBulkCancel();

    // Before the fix, mutateAsync had already fired twice by now.
    expect(mutateAsync).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Cancel 2 orders?");
    expect(dialog).toHaveTextContent(/linked invoices will be voided/i);
  });

  it("confirming cancels every selected order", async () => {
    selectAllAndClickBulkCancel();
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 orders" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync).toHaveBeenCalledWith({ id: "o1", status: "CANCELLED" });
    expect(mutateAsync).toHaveBeenCalledWith({ id: "o2", status: "CANCELLED" });
  });

  it("backing out of the confirm cancels nothing and closes it", async () => {
    selectAllAndClickBulkCancel();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
