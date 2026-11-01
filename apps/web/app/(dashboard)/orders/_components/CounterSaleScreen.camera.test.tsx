import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { playScanCue, unlockScanCue } from "@/lib/scan-cue";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1059: the counter's continuous camera on a phone. The camera HOOK is mocked (jsdom has no camera), so a test drives the
 * decoded frames itself, at a clock it controls; everything behind the hook is the real strip, queue, ladder and screen.
 * The API is mocked at apiClient (the lowest seam), as in CounterSaleScreen.scan.test.tsx.
 *
 *  C1/C2  a decode is a code, never a typed quantity   C3  one queue   C4  a typed quantity still multiplies
 *  C5     the repeat gap   C6  aim box + steady read   C7  the scanned level   C8  pauses   C9  frozen sale
 *  C10    frames dropped while the clerk is elsewhere   C11  touch-first focus   C12  a desktop till is unchanged
 *  W-1041 the new-customer window is a dialog: it drops frames from either door, with focus on a field or a button
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
  useCreateCustomer: () => ({
    mutate: (_payload: unknown, opts?: { onSuccess?: (d: unknown) => void }) =>
      opts?.onSuccess?.({
        customer: { id: "c-new", businessName: "Acme Cafe", pricingTier: 1, isWalkIn: false },
      }),
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  ...jest.requireActual("@/lib/api/tobacco"),
  useHasAddon: () => false,
}));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: () => <input aria-label="Street" />,
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

// The camera hook: records what the strip handed it (the pause and the frame callback) and whether it is mounted (camera on).
const mockCamera: {
  opts: { enabled: boolean; onDetect: (code: string, frame?: any) => void } | null;
  mounted: number;
} = { opts: null, mounted: 0 };
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: (opts: any) => {
    mockCamera.opts = opts;
    const R = jest.requireActual("react") as typeof React;
    R.useEffect(() => {
      mockCamera.mounted += 1;
      return () => {
        mockCamera.mounted -= 1;
      };
    }, []);
    return {
      videoRef: { current: null },
      torchAvailable: false,
      torchOn: false,
      toggleTorch: () => undefined,
      refocus: () => undefined,
      error: null,
    };
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
const CHIPS = {
  id: "p-chips",
  name: "Sample Chips",
  sku: "200000000002",
  pricePerUnit: 4,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
// A 24-pack priced 30.00 per case: its UNIT code is a loose can worth 30 / 24 = 1.25.
const PACK24 = {
  id: "p-pack",
  name: "Sample Cola 24pk",
  sku: "400500600011",
  unitSku: "400500600028",
  pricePerUnit: 30,
  unit: "case",
  unitsPerBox: 24,
  isActive: true,
};

type Handler = () => Promise<unknown> | unknown;
let barcodeFor: Record<string, Handler> = {};
let listFor: Record<string, Handler> = {};
const notFound = () => Promise.reject({ response: { status: 404 } });
const barcodeCalls = () =>
  (apiClient.get as jest.Mock).mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.startsWith("/products/barcode/"))
    .map((u) => decodeURIComponent(u.slice("/products/barcode/".length)));

// The clock the engine is fed: Date.now() is held, and a frame advances it by the gap the test names.
let clock = 1_000_000;
let dateSpy: jest.SpyInstance;
// A box in the video's pixel space, and the centre of a code inside it / outside it.
const AIM = { x: 100, y: 50, width: 400, height: 200 };
const INSIDE = {
  aimBox: AIM,
  bounds: { origin: { x: 290, y: 140 }, size: { width: 20, height: 20 } },
};
const OUTSIDE = {
  aimBox: AIM,
  bounds: { origin: { x: 5, y: 5 }, size: { width: 20, height: 20 } },
};

const setTouchFirst = (touch: boolean, reducedMotion = false, mdUp = false) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches:
        q === TOUCH_FIRST_QUERY
          ? touch
          : q.includes("min-width")
            ? mdUp
            : q.includes("prefers-reduced-motion") && reducedMotion,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  barcodeFor = {};
  listFor = {};
  quickKeys = { register: "main", cap: 12, keys: [] };
  mockCamera.opts = null;
  mockCamera.mounted = 0;
  clock = 1_000_000;
  dateSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/orders/counter-sale/quick-keys") return { data: quickKeys };
    if (url.startsWith("/products/barcode/")) {
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return barcodeFor[code] ? { data: await barcodeFor[code]() } : notFound();
    }
    if (url === "/products") {
      const code = cfg?.params?.scanCode ?? cfg?.params?.search;
      const rows = listFor[code]
        ? await listFor[code]()
        : barcodeFor[code]
          ? [await barcodeFor[code]()]
          : [];
      return { data: { data: rows } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mutateAsync.mockResolvedValue({
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
  setTouchFirst(true);
});
afterEach(() => {
  dateSpy.mockRestore();
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

let quickKeys: { register: string; cap: number; keys: unknown[] };
const scanField = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const wedge = async (text: string) => {
  fireEvent.change(scanField(), { target: { value: text } });
  fireEvent.submit(scanField().closest("form")!);
  await waitFor(() => expect(scanField().value).toBe(""));
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const openCamera = () => {
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  expect(mockCamera.opts).not.toBeNull();
};
/** `n` frames of `code`, `stepMs` apart: the engine's own clock is whatever Date.now() says at each one. */
const frames = (code: string, n: number, frame: unknown = INSIDE, stepMs = 100) => {
  for (let i = 0; i < n; i += 1) {
    clock += stepMs;
    act(() => mockCamera.opts!.onDetect(code, frame));
  }
};
/** A deliberate hold: far more than the three steady frames, so a recount (if any) has every chance to show. */
const hold = (code: string, n = 5) => frames(code, n);
const renderPhoneTill = () => {
  const out = renderTill(<CounterSaleScreen />);
  openCamera();
  return out;
};

describe("C1/C2: a decoded code is looked up whole, never parsed as typed text", () => {
  it("C1: decode '123' (no such product) is a miss on '123', with no pending quantity and no carry", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("123");
    await waitFor(() =>
      expect(screen.getByTestId("counter-scan-feedback")).toHaveTextContent("No product for '123'"),
    );
    expect(screen.queryByTestId("pending-qty")).toBeNull();
    // the next scan is NOT multiplied by 123
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(lines()[0]).not.toHaveTextContent("× 123");
  });

  it("C1: decode '123' that IS a product's exact code adds it once, as a code", async () => {
    barcodeFor["123"] = () => COLA;
    renderPhoneTill();
    hold("123");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(screen.queryByTestId("pending-qty")).toBeNull();
  });

  // parseScanField reads a quantity prefix as "2*code" or "2x code" (an x needs a space after it); "2x1234" alone is already a
  // single code there. The decode is looked up whole in every spelling, so the star and the spaced x are the rows that go red
  // through submit(), and "2x1234" pins that the plain spelling stays whole too.
  it.each(["2*1234", "2x 1234", "2x1234"])(
    "C2: decode '%s' is looked up WHOLE (never quantity 2 of '1234')",
    async (decoded) => {
      barcodeFor[decoded] = () => COLA;
      renderPhoneTill();
      hold(decoded);
      await waitFor(() => expect(lines()).toHaveLength(1));
      expect(lines()[0]).toHaveTextContent("× 1");
      expect(barcodeCalls()).toContain(decoded);
      expect(barcodeCalls()).not.toContain("1234");
    },
  );
});

describe("C3/C4: camera and wedge share ONE queue", () => {
  it("C3: wedge, camera, wedge, one code twice: queue order, and it counts twice", async () => {
    const gate = deferred<unknown>();
    barcodeFor["200000000001"] = () => gate.promise; // the first lookup holds the queue
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    await wedge("200000000001"); // 1: wedge, lookup in flight
    hold("200000000002"); // 2: camera, waits behind it
    await wedge("200000000001"); // 3: wedge, the same code again
    await waitFor(() => expect(barcodeCalls()).toEqual(["200000000001"]));
    gate.resolve(COLA);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
    expect(lines()[0]).toHaveTextContent("× 2");
    expect(lines()[1]).toHaveTextContent("Sample Chips");
    expect(lines()[1]).toHaveTextContent("× 1");
    expect(barcodeCalls()).toEqual(["200000000001", "200000000002", "200000000001"]);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$9.00");
  });

  it("C4: a typed quantity 3, then a camera scan: the line is quantity 3", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    await wedge("3");
    expect(screen.getByTestId("pending-qty")).toHaveTextContent("×3");
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("× 3");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$7.50");
    expect(screen.queryByTestId("pending-qty")).toBeNull();
  });
});

describe("C5/C6: the repeat gap, the aim box and the steady read", () => {
  it("C5: one code held for 20 frames counts once; away for the gap and back, it counts again", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 20);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("× 1");
    clock += 700; // out of view for longer than the 0.6 s repeat gap
    hold("200000000001", 5);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    expect(barcodeCalls()).toEqual(["200000000001", "200000000001"]);
  });

  it("C6: a code outside the aim box is not counted, and neither is a single passing frame", async () => {
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    frames("200000000001", 20, OUTSIDE); // held, but off-centre
    frames("200000000002", 1, INSIDE); // centred, but one frame
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(lines()).toHaveLength(0);
    expect(barcodeCalls()).toEqual([]);
  });
});

describe("C7: the scanned level decides the line, as it does for the wedge", () => {
  it("a UNIT code is one piece, a BOX code a whole box, a SHARED code the default sell unit", async () => {
    barcodeFor["400500600028"] = () => PACK24; // the UNIT code
    barcodeFor["400500600011"] = () => PACK24; // the BOX code
    barcodeFor["SHARED"] = () => ({
      ...PACK24,
      scanMatch: { code: "SHARED", levels: ["UNIT", "BOX"] },
    });
    renderPhoneTill();
    hold("400500600028");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("0 boxes + 1 pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$1.25");

    clock += 1000;
    hold("400500600011");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("1 box + 1 pcs"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$31.25");

    clock += 1000;
    hold("SHARED");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("2 boxes + 1 pcs"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$61.25");
  });
});

describe("C8: the camera pauses while the till waits on the clerk, and a held code does not recount", () => {
  it("an ambiguous code: the camera is off behind the picker, on again after the choice, and the held code does not recount", async () => {
    listFor["COLA"] = () => [COLA, CHIPS]; // a name search with two sellable hits and no exact code
    renderPhoneTill();
    hold("COLA", 3);
    const picker = await screen.findByTestId("counter-scan-picker");
    expect(mockCamera.opts!.enabled).toBe(false);
    expect(lines()).toHaveLength(0);
    // the clerk takes 2 s to choose; the code stays in front of the camera the whole time (the frames are dropped)
    hold("COLA", 20);
    expect(barcodeCalls().filter((c) => c === "COLA")).toHaveLength(1);
    fireEvent.click(within(picker).getByRole("button", { name: /Sample Chips/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(mockCamera.opts!.enabled).toBe(true);
    // still held: the same code keeps arriving after the pause and is NOT a new scan
    hold("COLA", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByTestId("counter-scan-picker")).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(barcodeCalls().filter((c) => c === "COLA")).toHaveLength(1);
  });

  it("a failed lookup: the camera is off until Retry, and the held code does not recount", async () => {
    let healthy = false;
    barcodeFor["200000000001"] = () =>
      healthy ? COLA : Promise.reject({ response: { status: 503, data: {} } });
    renderPhoneTill();
    hold("200000000001", 3);
    const alert = await screen.findByTestId("counter-scan-error");
    expect(mockCamera.opts!.enabled).toBe(false);
    hold("200000000001", 20); // held for 2 s while the error is up
    expect(lines()).toHaveLength(0);
    healthy = true;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(mockCamera.opts!.enabled).toBe(true);
    hold("200000000001", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(barcodeCalls().filter((c) => c === "200000000001")).toHaveLength(2); // the scan and its one retry
  });

  // MUST 3: the camera-off pause freezes the engine's clock until the FIRST ACCEPTED FRAME, not until the camera is back on:
  // the frames take a moment to arrive after Retry or a choice, and that moment is no time at all to a code held in view.
  it.each([700, 1500])(
    "a failed lookup: the first frame %i ms after Retry is the held code again, not a new scan",
    async (gap) => {
      let healthy = false;
      barcodeFor["200000000001"] = () =>
        healthy ? COLA : Promise.reject({ response: { status: 503, data: {} } });
      renderPhoneTill();
      hold("200000000001", 3);
      const alert = await screen.findByTestId("counter-scan-error");
      healthy = true;
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(lines()).toHaveLength(1));
      clock += gap; // the camera takes this long to deliver its first frame again
      hold("200000000001", 5);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toHaveTextContent("\u00d7 1");
      expect(barcodeCalls().filter((c) => c === "200000000001")).toHaveLength(2); // the scan and its one retry
    },
  );

  it.each([700, 1500])(
    "an ambiguous pick: the first frame %i ms after the choice does not reopen the picker or look up again",
    async (gap) => {
      listFor["COLA"] = () => [COLA, CHIPS];
      renderPhoneTill();
      hold("COLA", 3);
      const picker = await screen.findByTestId("counter-scan-picker");
      fireEvent.click(within(picker).getByRole("button", { name: /Sample Chips/ }));
      await waitFor(() => expect(lines()).toHaveLength(1));
      clock += gap;
      hold("COLA", 5);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(screen.queryByTestId("counter-scan-picker")).toBeNull();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toHaveTextContent("\u00d7 1");
      expect(barcodeCalls().filter((c) => c === "COLA")).toHaveLength(1);
    },
  );

  it("the strip stays mounted through the pause (its engine state is what keeps the held code from recounting)", async () => {
    listFor["COLA"] = () => [COLA, CHIPS];
    renderPhoneTill();
    hold("COLA", 3);
    await screen.findByTestId("counter-scan-picker");
    expect(screen.getByTestId("counter-camera-strip")).toBeInTheDocument();
    expect(mockCamera.mounted).toBe(1);
  });
});

describe("C9: a frozen sale takes no scan", () => {
  it("while the sale is posting nothing is added", async () => {
    const posting = deferred<unknown>();
    mutateAsync.mockReturnValueOnce(posting.promise);
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCamera.opts!.enabled).toBe(false);
    hold("200000000002", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(barcodeCalls()).toEqual(["200000000001"]);
    expect(lines()).toHaveLength(1);
    posting.resolve({
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

  it("an unknown outcome (the sale may have landed) is locked: no line", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    expect(mockCamera.opts!.enabled).toBe(false);
    hold("200000000002", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(barcodeCalls()).toEqual(["200000000001"]);
    expect(lines()).toHaveLength(1);
  });

  it("a receipt on screen: the camera is off and the strip is gone", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(screen.queryByTestId("counter-camera-strip")).toBeNull();
    expect(mockCamera.mounted).toBe(0);
  });
});

describe("MUST 3: the engine outlives the receipt", () => {
  it("New sale with the last item still in front of the camera adds no line", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    clock += 20_000; // the customer reads the receipt; the item never leaves the clerk's hand
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    await waitFor(() => expect(screen.getByTestId("counter-camera-strip")).toBeInTheDocument());
    hold("200000000001", 5); // the camera is back, and the same item is still in front of it
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(lines()).toHaveLength(0);
    expect(barcodeCalls()).toEqual(["200000000001"]);
  });
});

describe("C10: a frame is dropped while the clerk is doing something else", () => {
  it("with the tender field focused, a new code adds no line and the total does not change", async () => {
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
    const tender = screen.getByLabelText("Amount tendered") as HTMLInputElement;
    tender.focus();
    fireEvent.change(tender, { target: { value: "2" } });
    hold("200000000002", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(tender);
    expect(barcodeCalls()).toEqual(["200000000001"]);
    expect(lines()).toHaveLength(1);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"); // unchanged
  });

  it("an open dialog drops the frames too", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    try {
      hold("200000000001", 10);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(lines()).toHaveLength(0);
      expect(barcodeCalls()).toEqual([]);
    } finally {
      dialog.remove();
    }
    clock += 1000;
    hold("200000000001", 5); // the dialog is closed: it counts
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it("with the SCAN field focused, it counts", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    scanField().focus();
    expect(document.activeElement).toBe(scanField());
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it("a code held in view while the clerk types elsewhere (over 0.6 s) is not a new scan afterwards", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    const tender = screen.getByLabelText("Amount tendered") as HTMLInputElement;
    tender.focus();
    hold("200000000001", 20); // 2 s of dropped frames with the code still in front of the lens
    tender.blur();
    hold("200000000001", 10);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(barcodeCalls()).toEqual(["200000000001"]);
  });
});

describe("C10 clock: only the time the code was in view is frozen", () => {
  const addThenFocusTender = async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    const tender = screen.getByLabelText("Amount tendered") as HTMLInputElement;
    tender.focus();
    return tender;
  };
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

  it("the 'Camera paused' note shows while frames are being dropped, and goes on the next accepted frame", async () => {
    const tender = await addThenFocusTender();
    expect(screen.queryByText("Camera paused")).toBeNull();
    hold("200000000001", 1);
    expect(screen.getByText("Camera paused")).toBeInTheDocument();
    hold("200000000001", 10); // more dropped frames change nothing
    expect(screen.getAllByText("Camera paused")).toHaveLength(1);
    tender.blur();
    expect(screen.getByText("Camera paused")).toBeInTheDocument(); // not until a frame is accepted
    hold("200000000001", 1);
    expect(screen.queryByText("Camera paused")).toBeNull();
  });

  it("held in view across a 3 s block, the code is still the same scan afterwards", async () => {
    const tender = await addThenFocusTender();
    hold("200000000001", 30); // 3 s of dropped frames, the code in front of the lens the whole time
    tender.blur();
    hold("200000000001", 5);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toHaveTextContent("\u00d7 1");
  });

  it("away for 5 s after a block (no frames at all), the same code is a new scan when it comes back", async () => {
    const tender = await addThenFocusTender();
    hold("200000000001", 3); // dropped, then the code leaves the view
    tender.blur();
    clock += 5000; // nothing is in front of the camera for 5 s
    hold("200000000001", 5);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("\u00d7 2"));
    expect(barcodeCalls()).toEqual(["200000000001", "200000000001"]);
  });
});

describe("MUST 7: every counted camera scan is answered by sound; a wedge scan stays silent", () => {
  it("unlocks the sound in the tap that opens the strip, then cues each outcome", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderTill(<CounterSaleScreen />);
    expect(unlockScanCue).not.toHaveBeenCalled();
    openCamera();
    expect(unlockScanCue).toHaveBeenCalledTimes(1);

    hold("200000000001"); // added
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(playScanCue).toHaveBeenLastCalledWith("accepted");

    clock += 1000;
    hold("999999999999"); // a miss
    await screen.findByText("No product for '999999999999'");
    expect(playScanCue).toHaveBeenLastCalledWith("rejected");
    expect(playScanCue).toHaveBeenCalledTimes(2);
  });

  it("a wedge scan makes no sound", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    await wedge("200000000001");
    await wedge("999999999999");
    await screen.findByText("No product for '999999999999'");
    expect(playScanCue).not.toHaveBeenCalled();
  });

  it("a failed lookup, an ambiguous pick and a refused add (a line at its cap) are cued 'rejected'", async () => {
    barcodeFor["BROKEN"] = () => Promise.reject({ response: { status: 503, data: {} } });
    listFor["COLA"] = () => [COLA, CHIPS];
    renderPhoneTill();
    hold("BROKEN", 3);
    await screen.findByTestId("counter-scan-error");
    expect(playScanCue).toHaveBeenCalledWith("rejected");
    fireEvent.click(screen.getByRole("button", { name: "Skip this scan" }));
    (playScanCue as jest.Mock).mockClear();

    clock += 1000;
    hold("COLA", 3);
    await screen.findByTestId("counter-scan-picker");
    expect(playScanCue).toHaveBeenCalledTimes(1);
    expect(playScanCue).toHaveBeenLastCalledWith("rejected");
  });
});

describe("C11: on a touch-first device the keyboard is never raised for the clerk", () => {
  it("no autofocus on mount", () => {
    renderTill(<CounterSaleScreen />);
    expect(document.activeElement).not.toBe(scanField());
  });

  it("the re-arm after a scan is skipped (the cursor stays out of the scan field)", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderTill(<CounterSaleScreen />);
    await wedge("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).not.toBe(scanField());
  });

  it("opening the camera takes the cursor out of the scan field, so a keyboard already up goes down", () => {
    renderTill(<CounterSaleScreen />);
    scanField().focus();
    expect(document.activeElement).toBe(scanField());
    openCamera();
    expect(document.activeElement).not.toBe(scanField());
  });

  it("a wedge that types a LETTER first is routed to the scan field (a digit still is)", () => {
    renderTill(<CounterSaleScreen />);
    fireEvent.keyDown(document.body, { key: "A" });
    expect(document.activeElement).toBe(scanField());
    scanField().blur();
    fireEvent.keyDown(document.body, { key: "7" });
    expect(document.activeElement).toBe(scanField());
  });

  it("Enter in a quantity field lets go of it: the keyboard goes down and the camera counts again", async () => {
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => CHIPS;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    const qty = screen.getByLabelText("Set quantity of Sample Cola") as HTMLInputElement;
    qty.focus();
    fireEvent.change(qty, { target: { value: "3" } });
    expect(document.activeElement).toBe(qty);
    fireEvent.keyDown(qty, { key: "Enter" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(document.body);
    expect(lines()[0]).toHaveTextContent("\u00d7 3");
    hold("200000000002"); // a frame is no longer dropped as "the clerk is typing"
    await waitFor(() => expect(lines()).toHaveLength(2));
  });

  it("the customer find still takes focus when the clerk asks for it (Ship this order instead)", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderTill(<CounterSaleScreen />);
    await wedge("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Ship this order instead" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Find a customer")),
    );
  });
});

describe("MUST 9/10 and C12: the camera button is for touch-first devices only", () => {
  it("shows a 44 px 'Scan with camera' button inside the sticky bar, with the strip above the field", () => {
    renderTill(<CounterSaleScreen />);
    const bar = screen.getByTestId("counter-scan-bar");
    const button = within(bar).getByRole("button", { name: "Scan with camera" });
    expect(button.className).toMatch(/\bh-11\b/);
    expect(button.className).toMatch(/\bw-11\b/);
    expect(screen.queryByTestId("counter-camera-strip")).toBeNull(); // it does not open by itself
    fireEvent.click(button);
    const strip = within(bar).getByTestId("counter-camera-strip");
    expect(
      strip.compareDocumentPosition(scanField()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(screen.queryByTestId("counter-camera-strip")).toBeNull();
  });

  it("C12: not touch-first, there is no camera button, the scan field autofocuses, and a lowercase letter is not routed (SA-1067 M4: a capital is)", () => {
    setTouchFirst(false);
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByRole("button", { name: "Scan with camera" })).toBeNull();
    expect(document.activeElement).toBe(scanField());
    scanField().blur();
    fireEvent.keyDown(document.body, { key: "a" });
    expect(document.activeElement).not.toBe(scanField());
    fireEvent.keyDown(document.body, { key: "7" });
    expect(document.activeElement).toBe(scanField());
  });

  it("C12: with no matchMedia at all (jsdom, an old browser) it is a desktop till", () => {
    delete (window as unknown as Record<string, unknown>).matchMedia;
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByRole("button", { name: "Scan with camera" })).toBeNull();
    expect(document.activeElement).toBe(scanField());
  });
});

/**
 * MUST 10: the strip stays in view. The shell scrolls `#main-content` (under its header) and a floating checkout bar covers the
 * bottom of it below md, so opening the strip scrolls that container until the sticky scan bar rests at its top. jsdom has no
 * layout, so these rows prove the CALL (target, behaviour, the room added); the real capture measures the pixels:
 * `[data-testid="counter-scan-bar"]` top === `#main-content` top, strip/field/feedback above `[data-testid="counter-checkout-bar"]`.
 */
describe("MUST 10: opening the strip brings the scan bar to the top of the scroller", () => {
  const MAIN_TOP = 64;
  let main: HTMLElement;
  let scrollTo: jest.Mock;
  let rectSpy: jest.SpyInstance;
  const layout = (o: { barTop: number; scrollHeight: number; scrollTop?: number }) => {
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: o.scrollHeight });
    main.scrollTop = o.scrollTop ?? 200;
    rectSpy.mockImplementation(function (this: Element) {
      const top =
        this.id === "main-content"
          ? MAIN_TOP
          : this.getAttribute("data-testid") === "counter-scan-bar"
            ? o.barTop
            : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
  };
  beforeEach(() => {
    main = document.createElement("main");
    main.id = "main-content";
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 780 });
    scrollTo = jest.fn();
    main.scrollTo = scrollTo as unknown as typeof main.scrollTo;
    document.body.appendChild(main);
    rectSpy = jest.spyOn(Element.prototype, "getBoundingClientRect");
  });
  afterEach(() => {
    rectSpy.mockRestore();
    main.remove();
  });
  const spacer = () => screen.queryByTestId("counter-camera-room") as HTMLElement | null;

  it("scrolls the container so the scan bar's top lands at the container's top, smoothly", () => {
    layout({ barTop: 505, scrollHeight: 3000 });
    renderTill(<CounterSaleScreen />);
    expect(scrollTo).not.toHaveBeenCalled(); // nothing moves until the clerk taps
    openCamera();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 200 + (505 - MAIN_TOP), behavior: "smooth" });
    expect(spacer()!.style.height).toBe("0px"); // the page is long enough: no room added
  });

  it("a page too short to scroll that far gets the missing room, in flow above the checkout bar", () => {
    layout({ barTop: 505, scrollHeight: 1000 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    // target 641 + the 780 px viewport - 1000 px of page = 421 px short
    expect(spacer()!.style.height).toBe("421px");
    const bar = screen.getByTestId("counter-checkout-bar");
    expect(spacer()!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closing the strip takes the room away", () => {
    layout({ barTop: 505, scrollHeight: 1000 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    expect(spacer()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(screen.queryByTestId("counter-camera-strip")).toBeNull();
    expect(spacer()).toBeNull();
  });

  it("with reduced motion the jump is instant", () => {
    setTouchFirst(true, true);
    layout({ barTop: 505, scrollHeight: 3000 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    expect(scrollTo).toHaveBeenCalledWith({ top: 641, behavior: "auto" });
  });

  it("a scan bar already stuck at the top does not move the page", () => {
    layout({ barTop: MAIN_TOP, scrollHeight: 3000, scrollTop: 500 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "smooth" });
  });

  // SA-1066 F44: the strip's scroll must not leave the page where it put it. jsdom has no scroll, so this proves the CALL;
  // the browser row reads `#main-content`.scrollTop before opening and after Close camera (they must be equal).
  describe("F44: closing the strip puts the page back where it was", () => {
    it("closing scrolls the container back to the scrollTop it had when the strip opened", () => {
      layout({ barTop: 505, scrollHeight: 3000, scrollTop: 242 });
      renderTill(<CounterSaleScreen />);
      openCamera();
      expect(scrollTo).toHaveBeenLastCalledWith({
        top: 242 + (505 - MAIN_TOP),
        behavior: "smooth",
      });
      fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
      expect(screen.queryByTestId("counter-camera-strip")).toBeNull();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 242, behavior: "auto" });
    });

    it("a page that never moved (scrollTop 0) goes back to 0", () => {
      layout({ barTop: 505, scrollHeight: 3000, scrollTop: 0 });
      renderTill(<CounterSaleScreen />);
      openCamera();
      fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    });

    it("leaving the till with the strip open scrolls nothing (the next page owns the scroller)", () => {
      layout({ barTop: 505, scrollHeight: 3000, scrollTop: 242 });
      const { unmount } = renderTill(<CounterSaleScreen />);
      openCamera();
      scrollTo.mockClear();
      unmount();
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("from md up nothing was moved, so nothing is put back", () => {
      setTouchFirst(true, false, true);
      layout({ barTop: 505, scrollHeight: 1000, scrollTop: 242 });
      renderTill(<CounterSaleScreen />);
      openCamera();
      fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("coming back from a receipt, and a cart that changes", () => {
    const sellOneAndFinish = async () => {
      barcodeFor["200000000001"] = () => COLA;
      renderTill(<CounterSaleScreen />);
      openCamera();
      hold("200000000001");
      await waitFor(() => expect(lines()).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await screen.findByTestId("counter-sale-receipt");
    };

    it("New sale scrolls the scan bar to the top again (the strip is open again)", async () => {
      layout({ barTop: 505, scrollHeight: 3000 });
      await sellOneAndFinish();
      scrollTo.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      await screen.findByTestId("counter-camera-strip");
      expect(scrollTo).toHaveBeenCalledTimes(1);
      // New sale had put the page back at the top (scrollTop 0), so the bar's 441 px offset is the whole target
      expect(scrollTo).toHaveBeenCalledWith({ top: 441, behavior: "smooth" });
    });

    it("the room grows when a line goes away and the page gets shorter", async () => {
      layout({ barTop: 505, scrollHeight: 1200 });
      barcodeFor["200000000001"] = () => COLA;
      renderTill(<CounterSaleScreen />);
      openCamera();
      hold("200000000001");
      await waitFor(() => expect(lines()).toHaveLength(1));
      const before = Number.parseInt(spacer()!.style.height, 10);
      Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 }); // the line's height is gone
      scrollTo.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Remove Sample Cola" }));
      await waitFor(() => expect(lines()).toHaveLength(0));
      // target 641 + the 780 px viewport - 1000 px of page = 421 px short
      expect(spacer()!.style.height).toBe("421px");
      expect(Number.parseInt(spacer()!.style.height, 10)).toBeGreaterThan(before);
      expect(scrollTo).not.toHaveBeenCalled(); // the page is not moved under the clerk's hand
    });

    it("at md and up the checkout bar is not floating: nothing scrolls and no room is added", () => {
      setTouchFirst(true, false, true);
      layout({ barTop: 505, scrollHeight: 1000 });
      renderTill(<CounterSaleScreen />);
      openCamera();
      expect(scrollTo).not.toHaveBeenCalled();
      expect(spacer()!.style.height).toBe(""); // never touched
    });
  });

  it("without a scroll container (a test, an embedded view) opening still works and scrolls nothing", () => {
    main.remove();
    layout({ barTop: 505, scrollHeight: 3000 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    expect(screen.getByTestId("counter-camera-strip")).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("W-1041: the new-customer window pauses the camera", () => {
  // Radix hides the till behind an open window from the accessibility tree, so the cart is read from the DOM here.
  const rows = () =>
    Array.from(document.querySelectorAll('[aria-label="Items"] > li')).filter(
      (li) => li.textContent !== "No items yet.",
    );
  const renderAsking = () => {
    const out = renderWithProviders(<CounterSaleScreen />);
    openCamera();
    return out;
  };
  const openAdd = () => {
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "Acme Cafe" } });
    fireEvent.click(screen.getByRole("button", { name: 'Add "Acme Cafe" as a new customer' }));
  };
  const openBuyerDoor = () => fireEvent.click(screen.getByRole("button", { name: "New customer" }));
  const doors = [
    ["Add", renderPhoneTill, openAdd],
    ["the buyer question's New customer", renderAsking, openBuyerDoor],
  ] as const;
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

  describe.each(doors)("from %s", (_name, render, open) => {
    it.each([
      ["a field", () => screen.getByLabelText("Business Name")],
      ["a button", () => screen.getByRole("button", { name: "Cancel" })],
    ])(
      "with focus on %s, a decoded frame adds no line, looks nothing up and shows Camera paused",
      async (_f, target) => {
        barcodeFor["200000000001"] = () => COLA;
        render();
        open();
        expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "open");
        target().focus();
        expect(screen.queryByText("Camera paused")).toBeNull();
        hold("200000000001", 10);
        await settle();
        expect(rows()).toHaveLength(0);
        expect(barcodeCalls()).toEqual([]);
        expect(screen.getByText("Camera paused")).toBeInTheDocument();
      },
    );

    it.each([
      ["Cancel", "Cancel"],
      ["Save", "Create Customer"],
    ])(
      "a code held in view through %s is not recounted, and the next accepted frame scans",
      async (_n, button) => {
        barcodeFor["200000000001"] = () => COLA;
        barcodeFor["200000000002"] = () => CHIPS;
        render();
        hold("200000000001");
        await waitFor(() => expect(rows()).toHaveLength(1));
        open();
        screen.getByRole("button", { name: button }).focus();
        hold("200000000001", 20); // 2 s with the same code in front of the lens, all dropped
        fireEvent.change(screen.getByLabelText("Business Name"), {
          target: { value: "Acme Cafe" },
        });
        fireEvent.click(screen.getByRole("button", { name: button }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        hold("200000000001", 10);
        await settle();
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toHaveTextContent("\u00d7 1");
        expect(barcodeCalls()).toEqual(["200000000001"]);
        hold("200000000002", 5); // a new accepted frame after the window scans normally
        await waitFor(() => expect(rows()).toHaveLength(2));
      },
    );
  });
});

describe("SA-1066 camera: Added on the picture, Close at bottom-left, who is buying in the bar", () => {
  const strip = () => screen.getByTestId("counter-camera-strip");

  it("R8: a read puts `Added <name>` on the viewfinder (aria-hidden) and announces it once, in the status region", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    const overlay = await within(strip()).findByText("Added Sample Cola");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    const announced = screen
      .getAllByRole("status")
      .filter((el) => el.textContent?.includes("Added Sample Cola"));
    expect(announced).toHaveLength(1);
    expect(strip().contains(announced[0])).toBe(false);
  });

  it("R8a: Close camera sits bottom-left at 44 px and closes the camera like the toggle", () => {
    renderPhoneTill();
    const close = within(strip()).getByRole("button", { name: "Close camera" });
    expect(close.className).toMatch(/\bleft-1\b/);
    expect(close.className).toMatch(/\bbottom-1\b/);
    expect(close.className).toMatch(/\bh-11\b/);
    expect(close.className).toMatch(/\bw-11\b/);
    fireEvent.click(close);
    expect(screen.queryByTestId("counter-camera-strip")).toBeNull();
    expect(screen.getByRole("button", { name: "Scan with camera" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("R8b: with the camera open, the sticky bar names the buyer in one line below md; shut, nothing", () => {
    renderTill(<CounterSaleScreen />); // taps Walk-in, like the clerk
    expect(screen.queryByTestId("counter-camera-who")).toBeNull();
    openCamera();
    const who = screen.getByTestId("counter-camera-who");
    expect(who).toHaveTextContent(/^Walk-in$/);
    expect(who.className).toMatch(/\bmd:hidden\b/);
    expect(screen.getByTestId("counter-scan-bar").contains(who)).toBe(true);
  });

  it("R8b: before anyone is chosen there is no line to claim a buyer", () => {
    renderWithProviders(<CounterSaleScreen />); // the question is still unanswered
    openCamera();
    expect(screen.queryByTestId("counter-camera-who")).toBeNull();
  });
});

describe("SA-1071 K1/K3/K4: a held code, one step back from a read, and a closed camera say so", () => {
  const strip = () => screen.getByTestId("counter-camera-strip");
  const HELD_CUE = "Move it away to add another";
  const OFF_CUE = "Camera off. Tap Scan with camera to turn it back on.";
  const undoBtn = () => within(strip()).queryByRole("button", { name: "Undo" });

  it("K1: a code held in view after it counted says to move it away, and counts once with one beep", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 12);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect({
      cue: within(strip()).queryAllByText(HELD_CUE).length,
      qty: lines()[0].textContent?.includes("× 1"),
      beeps: (playScanCue as jest.Mock).mock.calls.length,
    }).toEqual({ cue: 1, qty: true, beeps: 1 });
  });

  it("K1: the cue goes once the code has left the picture", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 12);
    await waitFor(() => expect(within(strip()).queryAllByText(HELD_CUE)).toHaveLength(1));
    await waitFor(() => expect(within(strip()).queryAllByText(HELD_CUE)).toHaveLength(0), {
      timeout: 3000,
    });
    expect(lines()[0]).toHaveTextContent("× 1");
  });

  it("K1: a code that is lifted and shown again is a new count and carries no cue at that moment", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 12);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    clock += 700;
    hold("200000000001", 4);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
  });

  it("K3: Undo on the picture takes back a read that made the line: the line goes", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 4);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const undo = await waitFor(() => {
      const b = undoBtn();
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    expect(undo.closest('[aria-hidden="true"]')).toBeNull();
    expect(undo.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(undo);
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(undoBtn()).toBeNull();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$0.00");
  });

  it("K3: Undo on a read that raised a two-unit line takes one unit back; the line stays", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 4);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    clock += 700;
    hold("200000000001", 4);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    await waitFor(() => expect(undoBtn()).not.toBeNull());
    fireEvent.click(undoBtn()!);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    expect(lines()).toHaveLength(1);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
  });

  it("K3: when the line was edited since the read, Undo steps it down by what the read added; the line stays", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 4);
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Add one Sample Cola" }));
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    fireEvent.click(undoBtn()!);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    expect(lines()).toHaveLength(1);
  });

  it("K3 (review-a): a quick key after a read ends that read's Undo, so it can't take the wrong line", async () => {
    barcodeFor["200000000001"] = () => COLA;
    quickKeys.keys = [
      {
        productId: CHIPS.id,
        name: CHIPS.name,
        sellLevel: "UNIT",
        pinned: true,
        product: CHIPS,
      },
    ];
    renderPhoneTill();
    hold("200000000001", 4);
    await waitFor(() => expect(lines()).toHaveLength(1));
    await waitFor(() => expect(undoBtn()).not.toBeNull());
    fireEvent.click(await screen.findByTestId(`quick-key-${CHIPS.id}`));
    await waitFor(() => expect(lines()).toHaveLength(2));
    if (undoBtn()) fireEvent.click(undoBtn()!);
    await act(async () => {});
    expect(
      lines()
        .map((l) => l.textContent)
        .join(" "),
    ).toContain(COLA.name);
    expect(
      lines()
        .map((l) => l.textContent)
        .join(" "),
    ).toContain(CHIPS.name);
    expect(undoBtn()).toBeNull();
  });

  it("K3: Undo on a case read takes back one case, not one can", async () => {
    barcodeFor[PACK24.sku] = () => PACK24;
    renderPhoneTill();
    hold(PACK24.sku, 4);
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$30.00"));
    clock += 700;
    hold(PACK24.sku, 4);
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$60.00"));
    await waitFor(() => expect(undoBtn()).not.toBeNull());
    fireEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$30.00"));
  });

  it("K3: Undo on a read of 3 takes back all 3", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    hold("200000000001", 4);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    await wedge("3");
    clock += 700;
    hold("200000000001", 4);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 4"));
    await waitFor(() => expect(undoBtn()).not.toBeNull());
    fireEvent.click(undoBtn()!);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 1"));
    expect(lines()).toHaveLength(1);
  });

  it("K4: closing the camera says what happened, until the camera opens again", () => {
    renderPhoneTill();
    expect(screen.queryByText(OFF_CUE)).toBeNull();
    fireEvent.click(within(strip()).getByRole("button", { name: "Close camera" }));
    const cue = screen.getByText(OFF_CUE);
    expect(cue.closest("[role='status']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(screen.queryByText(OFF_CUE)).toBeNull();
  });

  it("K4: the line goes at the next scan", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderPhoneTill();
    fireEvent.click(within(strip()).getByRole("button", { name: "Close camera" }));
    expect(screen.getByText(OFF_CUE)).toBeInTheDocument();
    await wedge("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByText(OFF_CUE)).toBeNull();
  });

  it("K4: a camera that was never opened has no such line", () => {
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByText(OFF_CUE)).toBeNull();
  });
});

describe("SA-1071 K2: Payment shows once", () => {
  type IO = {
    cb: IntersectionObserverCallback;
    targets: Element[];
    opts?: IntersectionObserverInit;
  };
  let observers: IO[] = [];
  const realIO = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  beforeEach(() => {
    observers = [];
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      private rec: IO;
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        this.rec = { cb, targets: [], opts };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.rec.targets = [];
      }
      takeRecords() {
        return [];
      }
    };
  });
  afterEach(() => {
    (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = realIO;
  });
  const tenderRow = () => screen.queryAllByTestId("counter-bar-tender");
  /** the Payment section reports it is (not) in view */
  const paymentInView = (inView: boolean) => {
    const section = screen.getByRole("region", { name: "Payment" });
    const live = observers.filter((o) => o.targets.includes(section));
    // no observer yet (the base): nothing can report, and the row's count is what is read next
    act(() => {
      for (const o of live)
        o.cb(
          [{ isIntersecting: inView, target: section } as unknown as IntersectionObserverEntry],
          {} as never,
        );
    });
  };

  it("K2: Payment on screen hides the bar's tender row; scrolled off, it comes back", () => {
    renderPhoneTill();
    expect(tenderRow()).toHaveLength(1);
    paymentInView(true);
    expect(tenderRow()).toHaveLength(0);
    paymentInView(false);
    expect(tenderRow()).toHaveLength(1);
  });

  it("K2: Total and Amount due stay where F7 put them while the row is gone", () => {
    renderPhoneTill();
    paymentInView(true);
    expect(screen.getByTestId("running-total")).toBeInTheDocument();
  });

  it("K2: until the observer has answered (or with none), the row is there as before", () => {
    (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    renderPhoneTill();
    expect(tenderRow()).toHaveLength(1);
  });
});
