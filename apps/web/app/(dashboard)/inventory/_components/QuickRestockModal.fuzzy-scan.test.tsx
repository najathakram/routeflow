import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { QuickRestockModal } from "./QuickRestockModal";

/** B1219: a single FUZZY scan match is confirmed before it selects the product to restock. */

jest.mock("@/lib/api/inventory", () => ({
  useRecordPurchase: () => ({ mutate: jest.fn(), isPending: false }),
  usePurchaseOrders: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/vendor-bills", () => ({ useVendorBills: () => ({ data: { data: [] } }) }));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: ({ onScan }: { onScan: (code: string) => void }) => (
    <button type="button" onClick={() => onScan("123")}>
      Scan barcode
    </button>
  ),
}));

const FUZZY = { id: "p-fz", name: "Fuzzy Cola", sku: "FZ-1", unit: "each", currentStock: 7 };
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
  archivedMessage: () => "archived",
}));

const suggestion = {
  product: FUZZY,
  source: "search",
  ambiguous: true,
  suggestion: true,
  matches: [FUZZY],
};
const selected = () => screen.queryByText(/current stock/i);
function renderModal() {
  renderWithProviders(<QuickRestockModal suppliers={[]} products={[FUZZY]} onClose={jest.fn()} />);
}

beforeEach(() => jest.clearAllMocks());

describe("QuickRestockModal - fuzzy single match (B1219)", () => {
  it("selects nothing until Apply", async () => {
    mockResolve.mockResolvedValue(suggestion);
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    });
    const picker = await screen.findByRole("group", { name: /did you mean/i });
    expect(picker).toHaveTextContent("Did you mean Fuzzy Cola?");
    expect(selected()).toBeNull();

    fireEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(selected()).not.toBeNull());
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });

  it("Cancel selects nothing", async () => {
    mockResolve.mockResolvedValue(suggestion);
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    });
    const picker = await screen.findByRole("group", { name: /did you mean/i });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull());
    expect(selected()).toBeNull();
  });

  it("an exact hit still selects at once", async () => {
    mockResolve.mockResolvedValue({ product: FUZZY, source: "barcode" });
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    });
    await waitFor(() => expect(selected()).not.toBeNull());
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });
});
