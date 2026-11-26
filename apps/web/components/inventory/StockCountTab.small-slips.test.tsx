import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StockCountTab } from "./StockCountTab";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { readOnlyLine } from "@/lib/subscription-banner-state";
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
let mockOverview: unknown[] | undefined;
jest.mock("@/lib/api/inventory", () => ({ useStockOverview: () => ({ data: mockOverview }) }));
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
  mockOverview = undefined;
});

describe("B1481(d) a bare number in the scan box", () => {
  it("says 'No product for 40' and does not open New product", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderWithProviders(<StockCountTab />);
    await typeCode("40");
    expect(await screen.findByText("No product for 40")).toBeInTheDocument();
    expect(screen.queryByText(/New product form/)).toBeNull();
  });

  it("keeps the old path one tap away: the toast offers Add as new product, prefilled with the number", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderWithProviders(<StockCountTab />);
    await typeCode("40");
    fireEvent.click(await screen.findByRole("button", { name: "Add as new product" }));
    expect(await screen.findByText("New product form, SKU 40")).toBeInTheDocument();
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

describe("R-291 LOW: a saved-count message never outlives the next added item", () => {
  it("adding from the suggestion list clears it, so it does not return after Undo last scan", async () => {
    mockOverview = [
      { id: "p-1", name: "UX-pos Candy Bar", sku: "UX-CANDY", unit: "each", currentStock: -5 },
    ];
    commit.mockResolvedValue({ applied: 1, skipped: 0 });
    renderWithProviders(<StockCountTab />);
    await typeCode("UX-CANDY");
    await waitFor(() => expect(screen.queryByText("No items scanned yet")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Review & Commit/i }));
    const commitBtn = await screen.findByRole("button", { name: /^Commit 1 change$/ });
    await waitFor(() => expect(commitBtn).toBeEnabled());
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    expect(await screen.findByText("Count saved. 1 change applied to stock.")).toBeInTheDocument();

    fireEvent.change(scanBox(), { target: { value: "Candy" } });
    fireEvent.focus(scanBox());
    const option = await screen.findByRole("option", { name: /UX-pos Candy Bar/ });
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    await waitFor(() => expect(screen.queryByText("No items scanned yet")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Undo last scan/i }));
    });
    expect(await screen.findByText("No items scanned yet")).toBeInTheDocument();
    expect(screen.queryByText(/Count saved/)).toBeNull();
  });
});

describe("R-298: a read-only workspace is never offered New product from the count screen", () => {
  const renderReadOnly = () =>
    renderWithProviders(
      <ReadOnlyGateProvider view={{ status: "READ_ONLY" } as never}>
        <StockCountTab />
      </ReadOnlyGateProvider>,
    );

  it("a short number shows no Add as new product action, and the toast carries the gate line", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderReadOnly();
    await typeCode("40");
    expect(await screen.findByText("No product for 40")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add as new product" })).toBeNull();
    expect(
      screen.getByText(readOnlyLine({ status: "READ_ONLY" } as never, false)!),
    ).toBeInTheDocument();
  });

  it("reads the gate at click time: read-only after the scan, before the click, opens nothing", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    const ui = (view: unknown) => (
      <ReadOnlyGateProvider view={view as never}>
        <StockCountTab />
      </ReadOnlyGateProvider>
    );
    const { rerender } = renderWithProviders(ui(null));
    await typeCode("40");
    const action = await screen.findByRole("button", { name: "Add as new product" });
    rerender(ui({ status: "READ_ONLY" }));
    fireEvent.click(action);
    expect(screen.queryByText(/New product form/)).toBeNull();
  });

  it("an unknown 8+ digit scan does not open New product", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderReadOnly();
    await typeCode("4006381333931");
    expect(await screen.findByText("No product for 4006381333931")).toBeInTheDocument();
    expect(screen.queryByText(/New product form/)).toBeNull();
  });

  it("an unknown SKU with letters does not open New product", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    renderReadOnly();
    await typeCode("UX-NEW-1");
    expect(await screen.findByText("No product for UX-NEW-1")).toBeInTheDocument();
    expect(screen.queryByText(/New product form/)).toBeNull();
  });
});
