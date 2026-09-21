import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { StockCountTab } from "./StockCountTab";

/**
 * B672 spot-check (3 of 12 BarcodeScannerButton consumers) — StockCountTab is the ONE of the
 * three with its OWN Enter handler wired to the SAME input as the scanner (`scanInputRef`), so
 * it has the exact double-fire risk #982 had: `BarcodeScannerButton`'s detector now fires
 * (B672) and calls `preventDefault()`, but that does not stop this component's separate React
 * `onKeyDown` from ALSO calling `handleScan` on the same Enter. Real, found here (not
 * hypothetical) — fixed with the same `!e.defaultPrevented` guard as #982's.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// AuthProvider is the REAL provider (renderWithProviders mounts it) — safe with empty
// localStorage per its own doc comment; do not mock the whole @/lib/auth-context module.
jest.mock("@/lib/api/inventory", () => ({ useStockOverview: () => ({ data: undefined }) }));
jest.mock("@/lib/api/stock-count", () => {
  const actual = jest.requireActual("@/lib/api/stock-count");
  return {
    ...actual,
    useStartStockCount: () => ({
      mutateAsync: jest.fn().mockResolvedValue({ id: "session-1" }),
      isPending: false,
    }),
    useUpsertStockCountLine: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
    useRemoveStockCountLine: () => ({ mutate: jest.fn() }),
    useCommitStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
    useDiscardStockCountSession: () => ({ mutate: jest.fn(), isPending: false }),
    useStockCountSession: () => ({ data: undefined }),
    useStockCountSessions: () => ({ data: { data: [] } }),
  };
});

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
  archivedMessage: () => "archived",
}));

const search = () => screen.getByPlaceholderText(/scan with usb or webcam/i);

let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveProductByCode.mockResolvedValue({
    notFound: false,
    archived: false,
    source: "barcode",
    product: { id: "p-1", name: "Sample Cola", sku: "100200300", unit: "each" },
  });
  let t = 1_700_000_000_000;
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
});
afterEach(() => {
  dateNowSpy.mockRestore();
});

/** A physical wedge scanner: fast keydowns (feeding BarcodeScannerButton's own detector,
 *  independent of the input's value), landing the value on the full code, then Enter. */
function wedgeScan(code: string) {
  const input = search();
  for (const ch of code) {
    fireEvent.keyDown(input, { key: ch });
  }
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("a real wedge (USB) scan reaches handleScan exactly once (B672)", () => {
  it("does not double-add the scanned line", async () => {
    renderWithProviders(<StockCountTab />);

    await act(async () => {
      wedgeScan("100200300");
    });

    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalled());
    expect(mockResolveProductByCode).toHaveBeenCalledTimes(1);
    expect(search()).toHaveValue(""); // handleScan clears it; a second fire would re-scan stale text
  });
});
