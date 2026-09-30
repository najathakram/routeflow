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
let poState: { data?: unknown; isLoading: boolean; isError: boolean } = {
  data: { data: [] },
  isLoading: false,
  isError: false,
};
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: (params: unknown) => {
    lastPoParams = params;
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
