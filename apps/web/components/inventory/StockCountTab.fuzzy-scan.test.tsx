import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StockCountTab } from "./StockCountTab";

/** B1219: a single FUZZY scan match is confirmed ("Did you mean ...?") before it is counted. */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const mockUpsert = jest.fn();
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
    useUpsertStockCountLine: () => ({ mutate: mockUpsert, mutateAsync: mockUpsert }),
    useRemoveStockCountLine: () => ({ mutate: jest.fn() }),
    useCommitStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
    useDiscardStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
    useStockCountSession: () => ({ data: undefined }),
    useStockCountSessions: () => ({ data: { data: [] } }),
  };
});

const FUZZY = { id: "p-fz", name: "Fuzzy Cola", sku: "FZ-1", unit: "each" };
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
  archivedMessage: () => "archived",
}));

const search = () => screen.getByPlaceholderText(/scan with usb or webcam/i);
const scan = async (code: string) => {
  fireEvent.change(search(), { target: { value: code } });
  await act(async () => {
    fireEvent.keyDown(search(), { key: "Enter" });
  });
};
const suggestion = {
  product: FUZZY,
  source: "search",
  ambiguous: true,
  suggestion: true,
  matches: [FUZZY],
};

// The saved line the screen merges back after a successful write. A mock that resolves nothing makes the flush
// read `saved.id` of undefined, count the write as failed and re-queue it behind a 4 s retry timer that outlives the
// unmount and fires the upsert again inside a LATER test's "nothing was written" check.
const SAVED_LINE = {
  id: "line-1",
  expectedQty: 0,
  countedById: "u1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  product: { averageCost: null },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue(SAVED_LINE);
});
// An applied scan queues its count line behind the component's 900 ms flush debounce, which also outlives the unmount.
// Let it fire (and finish) inside the test that queued it.
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1000));
  });
});

describe("StockCountTab - fuzzy single match (B1219)", () => {
  it("counts nothing until Apply", async () => {
    mockResolve.mockResolvedValue(suggestion);
    renderWithProviders(<StockCountTab />);
    await scan("123");
    const picker = await screen.findByRole("group", { name: /did you mean/i });
    expect(picker).toHaveTextContent("Did you mean Fuzzy Cola?");
    expect(screen.queryByText("Fuzzy Cola")).toBeNull();

    fireEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Fuzzy Cola")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });

  it("Cancel counts nothing", async () => {
    mockResolve.mockResolvedValue(suggestion);
    renderWithProviders(<StockCountTab />);
    await scan("123");
    const picker = await screen.findByRole("group", { name: /did you mean/i });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull());
    expect(screen.queryByText("Fuzzy Cola")).toBeNull();
    // No count line was written (the session itself starts first - pre-existing ensureSession()).
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("2+ fuzzy hits list every match with an Apply per row; nothing counts until one is applied", async () => {
    const OTHER = { id: "p-ot", name: "Other Cola", sku: "OT-1", unit: "each" };
    mockResolve.mockResolvedValue({
      product: FUZZY,
      source: "search",
      ambiguous: true,
      matches: [FUZZY, OTHER],
    });
    renderWithProviders(<StockCountTab />);
    await scan("123");
    const picker = await screen.findByRole("group", { name: /did you mean/i });
    expect(picker).toHaveTextContent("Fuzzy Cola");
    expect(picker).toHaveTextContent("Other Cola");
    expect(mockUpsert).not.toHaveBeenCalled();
    fireEvent.click(within(picker).getByRole("button", { name: "Apply Other Cola" }));
    expect(await screen.findByText("Other Cola")).toBeInTheDocument();
    expect(screen.queryByText("Fuzzy Cola")).toBeNull();
  });

  it("an exact hit is still counted at once", async () => {
    mockResolve.mockResolvedValue({ product: FUZZY, source: "barcode" });
    renderWithProviders(<StockCountTab />);
    await scan("FZ-1");
    expect(await screen.findByText("Fuzzy Cola")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });
});
