import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StockCountTab } from "./StockCountTab";
import { StockCountReviewModal } from "./StockCountReviewModal";
import type { StockCountLocalRow } from "@/lib/api/stock-count";

/**
 * B1481 (UX audit 2026-11-26): the count screen's small slips.
 *  (a) "2 changees"  (b) no saved message after commit  (c) Qty per scan stays at the last value
 *  (d) a quantity typed into the scan box opens "New product" with 40 as the SKU.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/inventory", () => ({ useStockOverview: () => ({ data: undefined }) }));
const commit = jest.fn();
jest.mock("@/lib/api/stock-count", () => {
  const actual = jest.requireActual("@/lib/api/stock-count");
  return {
    ...actual,
    useStartStockCount: () => ({
      mutateAsync: jest.fn().mockResolvedValue({ id: "session-1" }),
      isPending: false,
    }),
    useUpsertStockCountLine: () => ({
      mutate: jest.fn(),
      mutateAsync: jest.fn().mockImplementation(async (v: { productId: string }) => ({
        id: `line-${v.productId}`,
        expectedQty: "-5",
        countedById: "u-1",
        updatedAt: "2026-11-26T00:00:00Z",
        product: { averageCost: "1" },
      })),
    }),
    useRemoveStockCountLine: () => ({ mutate: jest.fn() }),
    useCommitStockCountSession: () => ({
      mutateAsync: (...a: unknown[]) => commit(...a),
      isPending: false,
    }),
    useDiscardStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
    useStockCountSession: () => ({ data: undefined }),
    useStockCountSessions: () => ({ data: { data: [] } }),
  };
});
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
  archivedMessage: () => "archived",
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: ({ isOpen, initialSku }: { isOpen: boolean; initialSku: string }) =>
    isOpen ? <div>New product form, SKU {initialSku}</div> : null,
}));

const scanBox = () => screen.getByPlaceholderText(/scan with usb or webcam/i);
const typeCode = async (code: string) => {
  await act(async () => {
    fireEvent.change(scanBox(), { target: { value: code } });
    fireEvent.keyDown(scanBox(), { key: "Enter" });
  });
};
const found = {
  notFound: false,
  archived: false,
  source: "barcode",
  product: { id: "p-1", name: "UX-pos Candy Bar", sku: "UX-CANDY", unit: "each", currentStock: -5 },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue(found);
});

describe("B1481(d) a bare number in the scan box", () => {
  it("says 'No product for 40' and does not open New product", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderWithProviders(<StockCountTab />);
    await typeCode("40");
    expect(await screen.findByText("No product for 40")).toBeInTheDocument();
    expect(screen.queryByText(/New product form/)).toBeNull();
  });

  it("a real-looking unknown code (EAN-13) still opens New product with it as the SKU", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderWithProviders(<StockCountTab />);
    await typeCode("4006381333931");
    expect(await screen.findByText("New product form, SKU 4006381333931")).toBeInTheDocument();
  });

  it("an unknown SKU with letters still opens New product", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderWithProviders(<StockCountTab />);
    await typeCode("UX-NEW-1");
    expect(await screen.findByText("New product form, SKU UX-NEW-1")).toBeInTheDocument();
  });
});

describe("B1481(b)(c) after Commit", () => {
  it("says the count saved and puts Qty per scan back to 1", async () => {
    commit.mockResolvedValue({ applied: 1, skipped: 0 });
    renderWithProviders(<StockCountTab />);
    const qty = screen.getByLabelText("Qty per scan") as HTMLInputElement;
    fireEvent.change(qty, { target: { value: "22" } });
    expect(qty.value).toBe("22");
    await typeCode("UX-CANDY");
    await waitFor(() => expect(screen.queryByText("No items scanned yet")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Review & Commit/i }));
    const commitBtn = await screen.findByRole("button", { name: /^Commit 1 change$/ });
    await waitFor(() => expect(commitBtn).toBeEnabled());
    await act(async () => {
      fireEvent.click(commitBtn);
    });

    expect(await screen.findByText("Count saved. 1 change applied to stock.")).toBeInTheDocument();
    expect((screen.getByLabelText("Qty per scan") as HTMLInputElement).value).toBe("1");
  });
});

describe("B1481(a) the review header", () => {
  const row = (id: string): StockCountLocalRow => ({
    productId: id,
    name: `UX-pos item ${id}`,
    sku: id,
    unit: "each",
    currentStock: 1,
    expectedQty: 1,
    countedQty: 5,
    mode: "REPLACE",
    averageCost: 1,
    countedById: "u-1",
    updatedAt: "2026-11-26T00:00:00Z",
    lineId: `l-${id}`,
  });
  it("reads '2 changes', never 'changees'", () => {
    renderWithProviders(
      <StockCountReviewModal
        isOpen
        rows={[row("a"), row("b")]}
        notes=""
        onChangeNotes={jest.fn()}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        isSubmitting={false}
        unsavedCount={0}
        syncError={false}
        onRetrySync={jest.fn()}
        onChangeQty={jest.fn()}
        onChangeUnitCost={jest.fn()}
        onRemoveRow={jest.fn()}
        uncountedCount={0}
      />,
    );
    expect(screen.getByText("2 changes")).toBeInTheDocument();
    expect(screen.queryByText(/changees/)).toBeNull();
  });
});
