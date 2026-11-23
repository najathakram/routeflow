import * as React from "react";
import { screen, within, fireEvent, waitFor, renderWithProviders } from "@/test-utils/render";
import ExpensesPage from "./page";

/**
 * SA-1207 P2b: `/vendor-bills?fromPo=<id>` opens "New supplier bill" filled from that purchase order, in the
 * PO's own units, with a "From PO" chip, and lists every line that was not filled instead of dropping it.
 */

const mockReplace = jest.fn();
let mockSearch = "tab=inventory&fromPo=po1";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/vendor-bills",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn() },
}));
jest.mock("@/components/ScanInvoiceModal", () => ({ ScanInvoiceModal: () => null }));

let mockPo: unknown = null;
let mockPoList: Array<{ id: string; poNumber: string }> = [];
const mockMutate = jest.fn();
jest.mock("@/lib/api/vendor-bills", () => ({
  ...jest.requireActual("@/lib/api/vendor-bills"),
  useVendorBills: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1, needsMappingCount: 0 } },
    isLoading: false,
    isError: false,
  }),
  useCreateVendorBill: () => ({ mutate: mockMutate, isPending: false }),
  useBulkDeleteVendorBills: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/inventory", () => ({
  ...jest.requireActual("@/lib/api/inventory"),
  useSuppliers: () => ({ data: [{ id: "s1", name: "Acme Supply" }] }),
  usePurchaseOrders: () => ({ data: { data: mockPoList } }),
  usePurchaseOrder: (id: string | null) => ({ data: id ? mockPo : undefined }),
}));

const item = (over: Record<string, unknown>) => ({
  id: "i1",
  productId: "p1",
  product: { id: "p1", name: "Water", unit: "Piece" },
  qtyOrdered: "120",
  qtyReceived: "0",
  unitCost: "0.2083",
  totalCost: "25",
  packSize: 24,
  ...over,
});

const poWith = (items: unknown[], over: Record<string, unknown> = {}) => ({
  id: "po1",
  poNumber: "PO-7",
  status: "SENT",
  supplier: { id: "s1", name: "Acme Supply" },
  items,
  vendorBill: null,
  ...over,
});

describe("New supplier bill from a purchase order (P2b)", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockMutate.mockClear();
    mockPoList = [];
    mockSearch = "tab=inventory&fromPo=po1";
  });

  it("opens New supplier bill with a From PO chip and the line in boxes", async () => {
    mockPo = poWith([item({})]);
    renderWithProviders(<ExpensesPage />);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    expect(within(dialog).getByText("From PO PO-7")).toBeInTheDocument();
    expect(within(dialog).getByText("Qty (Box)")).toBeInTheDocument();
    const [qty, cost] = within(dialog).getAllByRole("spinbutton");
    expect(qty).toHaveValue(5);
    expect(cost).toHaveValue(5);
  });

  it("lists a line it could not fill and never claims the bill equals the PO", async () => {
    mockPo = poWith([
      item({}),
      item({
        id: "i2",
        productId: "p2",
        product: { id: "p2", name: "Soda", unit: "Piece" },
        qtyOrdered: "24.5",
        totalCost: "6",
      }),
    ]);
    renderWithProviders(<ExpensesPage />);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    expect(within(dialog).getByText(/Enter this line by hand/)).toBeInTheDocument();
    expect(within(dialog).getByText("Soda")).toBeInTheDocument();
    expect(within(dialog).queryByText(/matches the PO|same as the PO/i)).toBeNull();
  });

  it("does not open when the PO already has a bill", async () => {
    mockPo = poWith([item({})], {
      vendorBill: { id: "b1", billNumber: "BILL-1", status: "DRAFT" },
    });
    renderWithProviders(<ExpensesPage />);
    expect(screen.queryByRole("dialog", { name: /New supplier bill/ })).toBeNull();
  });

  // SA-1245 M2: while the form is filled from a PO, its supplier and PO link are fixed (Cancel starts over).
  it("locks the Supplier and the PO # while opened from a PO, and shows the PO it is linked to", async () => {
    mockPo = poWith([item({})]);
    renderWithProviders(<ExpensesPage />);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    const [supplier, poSelect] = within(dialog).getAllByRole("combobox");
    expect(supplier).toBeDisabled();
    expect(poSelect).toBeDisabled();
    expect(within(dialog).getByText("From PO PO-7")).toBeInTheDocument();
    expect((poSelect as HTMLSelectElement).selectedOptions[0].textContent).toBe("PO-7");
  });

  it("saves the bill linked to its PO with the filled lines", async () => {
    mockPo = poWith([item({})]);
    renderWithProviders(<ExpensesPage />);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    const [, due] = Array.from(dialog.querySelectorAll('input[type="date"]'));
    fireEvent.change(due, { target: { value: "2026-12-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create bill" }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toMatchObject({
      supplierId: "s1",
      purchaseOrderId: "po1",
      items: [expect.objectContaining({ description: "Water", qty: 5, unitCost: 5 })],
    });
  });

  it("Cancel drops the deep link, and a new bill is blank, unlinked and editable", async () => {
    mockPo = poWith([item({})]);
    mockReplace.mockImplementationOnce(() => {
      mockSearch = "tab=inventory";
      mockPo = null;
    });
    renderWithProviders(<ExpensesPage />);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mockReplace).toHaveBeenCalledWith("/vendor-bills?tab=inventory");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: /New bill/ })[0]);
    const fresh = await screen.findByRole("dialog", { name: /New supplier bill/ });
    const [supplier, poSelect] = within(fresh).getAllByRole("combobox");
    expect(supplier).toBeEnabled();
    expect(supplier).toHaveValue("");
    expect(poSelect).toHaveValue("");
    expect(within(fresh).queryByText(/From PO/)).toBeNull();
  });

  it("a bill not opened from a PO keeps both controls editable and offers the supplier's POs", async () => {
    mockSearch = "tab=inventory";
    mockPo = null;
    mockPoList = [{ id: "po1", poNumber: "PO-7" }];
    renderWithProviders(<ExpensesPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /New bill/ })[0]);
    const dialog = await screen.findByRole("dialog", { name: /New supplier bill/ });
    const [supplier, poSelect] = within(dialog).getAllByRole("combobox");
    expect(supplier).toBeEnabled();
    fireEvent.change(supplier, { target: { value: "s1" } });
    expect(poSelect).toBeEnabled();
    expect(within(dialog).getByRole("option", { name: "PO-7" })).toBeInTheDocument();
  });
});

describe("Purchase orders tab copy (P2b)", () => {
  it("no longer says the bill appears by itself", () => {
    mockSearch = "tab=pos";
    renderWithProviders(<ExpensesPage />);
    expect(screen.queryByText(/resulting supplier bill appears/)).toBeNull();
    expect(screen.getByText(/Create supplier bill/)).toBeInTheDocument();
  });
});
