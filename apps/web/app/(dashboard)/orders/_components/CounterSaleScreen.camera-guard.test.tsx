import * as React from "react";
import { act } from "@testing-library/react";
import { screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { playScanCue } from "@/lib/scan-cue";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1059: the screen's own guard on a camera code (`onCameraCode`), reached with the strip FORCED enabled. The strip drops
 * frames while the camera is paused, so through the real strip a posting sale never gets this far; this file replaces the strip
 * with a stub that hands the screen's `onCode` straight to the test, so the screen's guard is what is under test.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
const strip: { onCode: ((code: string) => void) | null } = { onCode: null };
jest.mock("./CounterCameraStrip", () => ({
  ...jest.requireActual("./CounterCameraStrip"),
  CounterCameraStrip: (props: { onCode: (code: string) => void }) => {
    strip.onCode = props.onCode;
    return <div data-testid="counter-camera-strip" />;
  },
}));

const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  sku: "200000000001",
  pricePerUnit: 2.5,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
const CHIPS = { ...COLA, id: "p-chips", name: "Sample Chips", sku: "200000000002" };
const PRODUCTS: Record<string, unknown> = { "200000000001": COLA, "200000000002": CHIPS };
const barcodeCalls = () =>
  (apiClient.get as jest.Mock).mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.startsWith("/products/barcode/"))
    .map((u) => decodeURIComponent(u.slice("/products/barcode/".length)));

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  strip.onCode = null;
  (apiClient.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url.startsWith("/products/barcode/")) {
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return PRODUCTS[code]
        ? { data: PRODUCTS[code] }
        : Promise.reject({ response: { status: 404 } });
    }
    if (url === "/products") return { data: { data: [] } };
    throw new Error(`unexpected GET ${url}`);
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q === TOUCH_FIRST_QUERY,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("onCameraCode: the screen's own guard", () => {
  it("a code that reaches the screen while the sale is posting adds no line and looks nothing up", async () => {
    let finish!: (v: unknown) => void;
    mutateAsync.mockReturnValueOnce(new Promise((res) => (finish = res)));
    renderTill(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(strip.onCode).not.toBeNull();
    act(() => strip.onCode!("200000000001")); // the strip is open and enabled: a sale to ring up
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    act(() => strip.onCode!("200000000002")); // a frame the strip let through during the POST
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(barcodeCalls()).toEqual(["200000000001"]);
    expect(lines()).toHaveLength(1);
    // the guard returns before the queue, as the wedge's does: nothing is queued, so nothing is looked up or dropped
    // later by the queue (which would answer the camera with a "rejected" sound for a frame that never was a scan)
    expect(screen.queryByTestId("counter-scan-feedback")).not.toHaveTextContent("Sample Chips");
    expect(playScanCue).toHaveBeenCalledTimes(1); // the one add before the sale
    expect(playScanCue).toHaveBeenLastCalledWith("accepted");
    await act(async () => {
      finish({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.5,
        paid: 20,
        balanceDue: 0,
        change: 17.5,
        paymentRecorded: true,
      });
    });
  });
});
