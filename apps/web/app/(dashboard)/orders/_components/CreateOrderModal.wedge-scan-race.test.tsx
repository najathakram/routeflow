import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B670/B672 (LANE-S investigation, requested by Mac Lead off #982 @09314c2b's proof failure).
 *
 * Two real, separate defects chained together, both now fixed:
 *  - B672 (BarcodeScannerButton.tsx, shared, pre-existing on master): the USB-wedge detector's
 *    keydown listener depended on the `onScan` PROP directly, so any parent that re-renders on
 *    every keystroke (every real caller, including this one) tore the listener down mid-sequence
 *    and it could never reach its own 6-char length gate — a real wedge scanner never tripped it,
 *    at any typing speed. Fixed by routing through the existing `onScanRef` (its own PR).
 *  - B672 follow-up (here, #982-owned): once the detector CAN fire, `preventDefault()` on the
 *    scan's Enter keydown does not stop this modal's SEPARATE React `onKeyDown` from ALSO firing
 *    on the same event — so a real wedge scan double-added: once correctly (+1, via the
 *    detector) and once via `handleProductSearchEnter`, which (mis)treats any Enter as a
 *    manually-typed SKU and applies the Qty field. Fixed with an `e.defaultPrevented` check.
 *
 * `BarcodeScannerButton` is deliberately left UNMOCKED so the real listener races the real one;
 * `Date.now()` is stubbed to advance a fixed 10ms per call (well under the detector's 200ms/150ms
 * thresholds) so the wedge sequence is detected deterministically regardless of machine load —
 * ruling out timing as an explanation either way.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }), // step 10's typed-Qty path is what races
  useScanV2: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
// #2696: the add-qty field is gone; a line's qty is edited on the line itself.
const lineQty = (name: string) =>
  lineFor(name).querySelector('input[aria-label="Quantity"]') as HTMLInputElement;
const unitsOf = (name: string) => lineQty(name)?.value ?? "";
const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;

async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  const row = await screen.findByRole("button", { name: new RegExp(name, "i") });
  fireEvent.click(row);
}

/** A physical wedge scanner: fast keydowns (feeding BarcodeScannerButton's OWN sequence
 *  detector, independent of the input's value), the value landing on the full code (as a real
 *  keyboard-emulating scanner types it), then Enter — all within the detector's thresholds. */
function wedgeScan(code: string) {
  const input = search();
  for (const ch of code) {
    fireEvent.keyDown(input, { key: ch });
  }
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  jest.clearAllMocks();
  let t = 1_700_000_000_000;
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
});
afterEach(() => {
  dateNowSpy.mockRestore();
});

describe("a real wedge (USB) scan of an EXISTING line — adds exactly one (Mac Lead / #982, #2696)", () => {
  it("adds exactly +1 to the line's edited qty and never duplicates the line", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

    // Sample Cola already on the order, its qty edited on the line to 4.
    await pick("Sample Cola");
    await waitFor(() => expect(unitsOf("Sample Cola")).toBe("1"));
    fireEvent.change(lineQty("Sample Cola"), { target: { value: "4" } });
    await waitFor(() => expect(unitsOf("Sample Cola")).toBe("4"));
    mockToast.mockClear();

    await act(async () => {
      wedgeScan(PLAIN.sku);
    });

    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalled());
    // Exactly ONE resolution: the detector fires (B672) and the modal's own Enter handler
    // bails on e.defaultPrevented instead of double-firing.
    expect(mockResolveProductByCode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(unitsOf("Sample Cola")).toBe("5")); // +1 on the edited qty
    expect(screen.getAllByTitle("Remove")).toHaveLength(1); // one line, not a duplicate
  });
});
