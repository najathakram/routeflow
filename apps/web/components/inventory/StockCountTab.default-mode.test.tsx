import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StockCountTab } from "./StockCountTab";
import { StockCountReviewModal } from "./StockCountReviewModal";
import type { StockCountLocalRow } from "@/lib/api/stock-count";

/**
 * B1474: a shelf count REPLACES stock by default. "COUNTED 40 on -5" must read AFTER 40, not AFTER 35.
 * "Add to existing" stays one pick away, and the review table says "Add" on a row that adds.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/inventory", () => ({ useStockOverview: () => ({ data: undefined }) }));
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
    useCommitStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
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

const row = (over: Partial<StockCountLocalRow>): StockCountLocalRow => ({
  productId: "p-1",
  name: "UX-pos Candy Bar",
  sku: "UX-CANDY",
  unit: "each",
  currentStock: -5,
  expectedQty: -5,
  countedQty: 40,
  mode: "REPLACE",
  averageCost: 1,
  countedById: "u-1",
  updatedAt: "2026-11-26T00:00:00Z",
  lineId: "line-1",
  ...over,
});

function review(rows: StockCountLocalRow[]) {
  renderWithProviders(
    <StockCountReviewModal
      isOpen
      rows={rows}
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
}

describe("count default mode (B1474)", () => {
  it("scan 40 on a product at -5, then Review: AFTER reads 40, not 35", async () => {
    mockResolve.mockResolvedValue({
      notFound: false,
      archived: false,
      source: "barcode",
      product: {
        id: "p-1",
        name: "UX-pos Candy Bar",
        sku: "UX-CANDY",
        unit: "each",
        currentStock: -5,
      },
    });
    renderWithProviders(<StockCountTab />);
    fireEvent.change(screen.getByLabelText("Qty per scan"), { target: { value: "40" } });
    const box = screen.getByPlaceholderText(/scan with usb or webcam/i);
    await act(async () => {
      fireEvent.change(box, { target: { value: "UX-CANDY" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await waitFor(() => expect(screen.queryByText("No items scanned yet")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Review & Commit/i }));
    const modal = (await screen.findByText("Review stock count")).closest(".fixed") as HTMLElement;
    const tr = within(modal).getByText("UX-pos Candy Bar").closest("tr")!;
    expect(tr.querySelectorAll("td")[3]).toHaveTextContent("40"); // After
    expect(tr.querySelectorAll("td")[4]).toHaveTextContent("+45"); // Variance
  });

  it("starts on Replace count, with Add to existing still offered", () => {
    renderWithProviders(<StockCountTab />);
    const select = screen.getByDisplayValue("Replace count") as HTMLSelectElement;
    expect(select.value).toBe("REPLACE");
    expect(screen.getByRole("option", { name: "Add to existing" })).toBeInTheDocument();
  });

  it("COUNTED 40 on -5 shows AFTER 40 when replacing", () => {
    review([row({ mode: "REPLACE" })]);
    const cells = screen.getByText("UX-pos Candy Bar").closest("tr")!.querySelectorAll("td");
    expect(cells[3]).toHaveTextContent("40"); // After
    expect(cells[4]).toHaveTextContent("+45"); // Variance
    expect(screen.queryByText("Add")).toBeNull();
  });

  it("an adding row says Add and lands on 35", () => {
    review([row({ mode: "ADD" })]);
    const tr = screen.getByText("UX-pos Candy Bar").closest("tr")!;
    expect(tr.querySelectorAll("td")[3]).toHaveTextContent("35");
    expect(screen.getByText("Add")).toBeInTheDocument();
  });
});
