/**
 * P-21 (573), I8: the PO detail reads its own lines' products by id and never asks for the whole catalog on load.
 * The real products hooks run; only the HTTP client is mocked, so this asserts the requests the page makes.
 * The add-line picker inside the Edit modal still needs the catalog, and reads it only once Edit is opened.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { PurchaseOrderDetail } from "./PurchaseOrderDetail";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});
jest.mock("@/lib/api/plan-flags", () => ({
  usePlanFlag: () => ({ enabled: true, resolved: true, failed: false }),
}));

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const po = {
  id: "po1",
  poNumber: "PO-0007",
  status: "SENT",
  supplier: { id: "s1", name: "Acme Supply", isActive: true },
  totalAmount: "80.00",
  createdAt: "2026-10-01T00:00:00.000Z",
  items: [P1, P2].map((productId, i) => ({
    id: `i${i}`,
    productId,
    product: { id: productId, name: `Widget ${i + 1}`, unit: "ea" },
    qtyOrdered: "20",
    qtyReceived: "0",
    unitCost: "4",
    totalCost: "80",
  })),
  receipts: [],
  vendorBill: null,
};
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrder: () => ({ data: po, isLoading: false, isError: false, refetch: jest.fn() }),
  useSendPurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useClosePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useReceivePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useSuppliers: () => ({ data: [{ id: "s1", name: "Acme Supply", isActive: true }] }),
}));
jest.mock("../../inventory/_components/PurchaseOrdersEditModal", () => ({
  PurchaseOrdersEditModal: ({ products }: { products: { id: string }[] }) => (
    <div data-testid="edit-modal">{products.map((p) => p.id).join(",")}</div>
  ),
}));
jest.mock("../../inventory/_components/PurchaseOrdersReceiveModal", () => ({
  ReceivePOModal: ({ products }: { products: { id: string }[] }) => (
    <div data-testid="receive-modal">{products.map((p) => p.id).join(",")}</div>
  ),
}));

const mockedGet = apiClient.get as jest.Mock;
const productsCalls = () =>
  mockedGet.mock.calls.filter((c) => c[0] === "/products").map((c) => c[1]?.params ?? {});

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockImplementation((url: string, cfg: { params?: Record<string, unknown> }) => {
    if (url !== "/products") return Promise.resolve({ data: {} });
    const ids = typeof cfg.params?.ids === "string" ? cfg.params.ids.split(",") : [P1, P2, "other"];
    return Promise.resolve({
      data: {
        data: ids.map((id) => ({ id, name: `Row ${id.slice(-1)}`, sku: `S-${id.slice(-1)}` })),
      },
    });
  });
});

const mount = () => {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PurchaseOrderDetail id="po1" />
    </QueryClientProvider>,
  );
};

describe("PurchaseOrderDetail reads products by ids (I8)", () => {
  it("on load it asks for exactly its lines' ids and makes no limit=0 request", async () => {
    mount();
    await waitFor(() => expect(productsCalls().length).toBeGreaterThan(0));
    expect(productsCalls()).toEqual([{ ids: `${P1},${P2}` }]);
  });

  it("the receive modal gets exactly the lines' products", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Receive" }));
    await waitFor(() =>
      expect(screen.getByTestId("receive-modal").textContent).toBe(`${P1},${P2}`),
    );
  });

  it("the whole catalog is read only once Edit is opened, for the add-line picker", async () => {
    mount();
    await screen.findByRole("button", { name: "Edit" });
    expect(productsCalls().some((p) => p.limit === 0)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(screen.getByTestId("edit-modal").textContent).toBe(`${P1},${P2},other`),
    );
    expect(productsCalls().filter((p) => p.limit === 0)).toEqual([{ isActive: true, limit: 0 }]);
  });
});
