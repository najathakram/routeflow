import * as React from "react";
import { act } from "@testing-library/react";
import { screen, waitFor, fireEvent, within } from "@/test-utils/render";
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

const setTouchFirst = (touch: boolean, reducedMotion = false) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches:
        q === TOUCH_FIRST_QUERY ? touch : q.includes("prefers-reduced-motion") && reducedMotion,
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
  mockCamera.opts = null;
  mockCamera.mounted = 0;
  clock = 1_000_000;
  dateSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
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

  it("C12: not touch-first, there is no camera button, the scan field autofocuses, and a letter is not routed", () => {
    setTouchFirst(false);
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByRole("button", { name: "Scan with camera" })).toBeNull();
    expect(document.activeElement).toBe(scanField());
    scanField().blur();
    fireEvent.keyDown(document.body, { key: "A" });
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

  it("without a scroll container (a test, an embedded view) opening still works and scrolls nothing", () => {
    main.remove();
    layout({ barTop: 505, scrollHeight: 3000 });
    renderTill(<CounterSaleScreen />);
    openCamera();
    expect(screen.getByTestId("counter-camera-strip")).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
