import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import PurchaseOrdersPage from "./page";

const setTitle = jest.fn();
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle }) }));

jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

const refetch = jest.fn();
let lastPoParams: unknown;
let lastPoOpts: unknown;
let paramsSeen: Array<Record<string, unknown>> = [];
let poState: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  isPlaceholderData?: boolean;
} = {
  data: { data: [] },
  isLoading: false,
  isError: false,
};
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: (params: Record<string, unknown>, opts: unknown) => {
    lastPoParams = params;
    lastPoOpts = opts;
    paramsSeen.push(params);
    return { ...poState, refetch };
  },
  usePurchaseOrder: () => ({ data: undefined, isLoading: false }),
  useSendPurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useClosePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useCreatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useReceivePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useSuppliers: () => ({ data: [{ id: "s1", name: "Acme Supply", isActive: true }] }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [{ id: "p1", name: "Widget", sku: "W-1" }] } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  poState = { data: { data: [] }, isLoading: false, isError: false };
  paramsSeen = [];
});

describe("/purchase-orders page", () => {
  it("sets the page title and offers New purchase order", () => {
    render(<PurchaseOrdersPage />);
    expect(setTitle).toHaveBeenCalledWith("Purchase Orders");
    fireEvent.click(screen.getByRole("button", { name: "New purchase order" }));
    expect(screen.getByRole("button", { name: "Create PO" })).toBeInTheDocument();
  });

  it("shows manual-only empty copy that never promises invoice scanning", () => {
    render(<PurchaseOrdersPage />);
    expect(screen.getByText(/No purchase orders yet\. Create one/)).toBeInTheDocument();
    expect(screen.queryByText(/scan/i)).not.toBeInTheDocument();
  });

  it("has a page header", () => {
    render(<PurchaseOrdersPage />);
    expect(screen.getByRole("heading", { level: 2, name: "Purchase Orders" })).toBeInTheDocument();
  });

  it("pages a long list: shows the range, total and a working Next", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `po${i}`,
      poNumber: `PO-${i}`,
      status: "DRAFT",
      supplier: { name: "Acme Supply" },
      lines: [],
      total: 0,
    }));
    poState = {
      data: { data: rows, meta: { total: 45, page: 1, limit: 20, totalPages: 3 } },
      isLoading: false,
      isError: false,
    };
    render(<PurchaseOrdersPage />);
    expect(screen.getByText("Showing 1–20 of 45")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(lastPoParams).toMatchObject({ page: 2, limit: 20 });
  });

  const pagedState = (totalPages: number, total: number) => ({
    data: {
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `po${i}`,
        poNumber: `PO-${i}`,
        status: "DRAFT",
        supplier: { name: "Acme Supply" },
        lines: [],
        total: 0,
      })),
      meta: { total, page: 1, limit: 20, totalPages },
    },
    isLoading: false,
    isError: false,
  });

  it("changing a filter goes to page 1 in the same event: no fetch on a stale page", () => {
    poState = pagedState(3, 45);
    render(<PurchaseOrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    paramsSeen = [];
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "DRAFT" } });
    expect(paramsSeen.length).toBeGreaterThan(0);
    expect(paramsSeen.every((p) => p.page === 1)).toBe(true);
  });

  it("steps back to the last page when the list shrinks under it", () => {
    poState = pagedState(3, 45);
    const { rerender } = render(<PurchaseOrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect((lastPoParams as { page: number }).page).toBe(2);
    poState = pagedState(1, 12);
    rerender(<PurchaseOrdersPage />);
    expect((lastPoParams as { page: number }).page).toBe(1);
  });

  it("keeps the previous page on screen while the next loads", () => {
    render(<PurchaseOrdersPage />);
    expect(lastPoOpts).toMatchObject({ keepPrevious: true });
  });

  it("dims the table, marks it busy and disables the pager while showing placeholder rows", () => {
    poState = { ...pagedState(3, 45), isFetching: true, isPlaceholderData: true };
    const { container } = render(<PurchaseOrdersPage />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByText("Updating…")).toBeInTheDocument();
  });

  it("does not step back while a fetch is in flight (a failed page-2 fetch is not hidden)", () => {
    poState = pagedState(3, 45);
    const { rerender } = render(<PurchaseOrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    poState = { ...pagedState(1, 12), isFetching: true };
    rerender(<PurchaseOrdersPage />);
    expect((lastPoParams as { page: number }).page).toBe(2);
  });

  it("Clear filters returns to page 1 with no filters", () => {
    poState = pagedState(3, 45);
    render(<PurchaseOrdersPage />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "DRAFT" } });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(lastPoParams).toMatchObject({ page: 1, status: undefined });
  });

  it("never renders a 'Showing 21–0 of 0' range", () => {
    poState = pagedState(0, 0);
    render(<PurchaseOrdersPage />);
    fireEvent.click(screen.queryByRole("button", { name: "Next page" }) ?? document.body);
    expect(screen.queryByText(/Showing 21/)).not.toBeInTheDocument();
  });

  it("hides the pager when everything fits on one page", () => {
    poState = {
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } },
      isLoading: false,
      isError: false,
    };
    render(<PurchaseOrdersPage />);
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows skeleton rows while loading, not the empty state", () => {
    poState = { data: undefined, isLoading: true, isError: false };
    const { container } = render(<PurchaseOrdersPage />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No purchase orders yet/)).not.toBeInTheDocument();
  });

  it("shows a readable error with Retry and never the raw message", () => {
    poState = {
      data: undefined,
      isLoading: false,
      isError: true,
      ...({ error: new Error("AxiosError: 500 boom") } as object),
    };
    render(<PurchaseOrdersPage />);
    expect(screen.getByText("Couldn't load purchase orders.")).toBeInTheDocument();
    expect(screen.queryByText(/boom|AxiosError/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText(/No purchase orders yet/)).not.toBeInTheDocument();
  });
});
