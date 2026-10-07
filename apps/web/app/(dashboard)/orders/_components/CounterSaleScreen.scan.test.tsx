import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Counter sale scan path (B1206-B1208). The API is mocked at apiClient (the lowest seam), so the
 * screen resolves a scan through the REAL shared ladder (`resolveProductByCode`).
 *
 *  B1206  two scans inside the lookup time are two lines, each with its own typed quantity.
 *  B1207  the exact product, never row 0 of a fuzzy list; an ambiguous code opens a picker; a FAILED lookup
 *         is a retryable error, never "No product found".
 *  B1208  the scanned LEVEL decides the line: a UNIT code on a 24-pack is ONE piece at 30.00 / 24 = 1.25.
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
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  barcodeFor = {};
  listFor = {};
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
          ? [await barcodeFor[code]()] // the fuzzy list also finds an exact code's product
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
    total: 1.25,
    paid: 20,
    balanceDue: 0,
    change: 18.75,
    paymentRecorded: true,
  });
});

const submitScan = (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
};
const scan = async (text: string) => {
  submitScan(text);
  await waitFor(() =>
    expect((screen.getByLabelText("Scan or search items") as HTMLInputElement).value).toBe(""),
  );
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
// the empty cart renders one placeholder <li>; it is not a line
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("B1206: a FIFO scan queue (no scan is dropped)", () => {
  it("two scans inside the lookup time are two lines in SCAN order (the queue serializes late replies), each with its OWN typed quantity", async () => {
    const colaReply = deferred<unknown>();
    const chipsReply = deferred<unknown>();
    barcodeFor["200000000001"] = () => colaReply.promise;
    listFor["200000000001"] = () => colaReply.promise.then((p) => [p]);
    barcodeFor["200000000002"] = () => chipsReply.promise;
    listFor["200000000002"] = () => chipsReply.promise.then((p) => [p]);
    renderWithProviders(<CounterSaleScreen />);

    await scan("3"); // quantity prefix for the NEXT scan only
    await scan("200000000001"); // lookup 1 still in flight ...
    await scan("200000000002"); // ... when scan 2 arrives
    chipsReply.resolve(CHIPS); // the later reply arrives FIRST ...
    colaReply.resolve(COLA); // ... but the queue serializes: cola still lands first

    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
    expect(lines()[0]).toHaveTextContent("× 3");
    expect(lines()[1]).toHaveTextContent("Sample Chips");
    expect(lines()[1]).toHaveTextContent("× 1");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$11.50");
  });
});

describe("B1207: the exact product, a picker on ambiguity, an error that is not 'not found'", () => {
  it("two codes sharing an 11-digit prefix: the SECOND code adds the second product, not row 0 of the list", async () => {
    listFor["200000000002"] = () => [COLA, CHIPS]; // fuzzy contains-search: name-sorted, the wrong one first
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000002");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Chips");
    expect(screen.queryByText(/Sample Cola/)).toBeNull();
  });

  it("an ambiguous code opens a picker and adds NOTHING until one is chosen", async () => {
    listFor["COLA"] = () => [COLA, CHIPS]; // a name search with two sellable hits and no exact code
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const picker = await screen.findByTestId("counter-scan-picker");
    expect(lines()).toHaveLength(0);
    expect(within(picker).getByRole("button", { name: /Sample Cola/ })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: /Sample Chips/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Chips");
    expect(screen.queryByTestId("counter-scan-picker")).toBeNull();
  });

  it("a FAILED lookup (5xx) is a retryable error, not 'No product found'; Retry adds the line", async () => {
    let healthy = false;
    barcodeFor["200000000001"] = () =>
      healthy ? COLA : Promise.reject({ response: { status: 503, data: {} } });
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    const alert = await screen.findByTestId("counter-scan-error");
    expect(alert).toHaveTextContent(/couldn't look up/i);
    expect(screen.queryByText(/No product found/)).toBeNull();
    expect(lines()).toHaveLength(0);
    healthy = true;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByTestId("counter-scan-error")).toBeNull();
  });

  it("a genuine miss still reads 'No product found for that code.'", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("999999999999");
    expect(await screen.findByText("No product found for that code.")).toBeInTheDocument();
  });
});

describe("B1208: the scanned level decides the line", () => {
  beforeEach(() => {
    barcodeFor["400500600028"] = () => PACK24; // the UNIT code
    barcodeFor["400500600011"] = () => PACK24; // the BOX code
  });

  it("a UNIT-code scan on a 24-pack at 30.00 is ONE piece at 1.25 (not a 30.00 box)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("400500600028");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("0 boxes + 1 pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$1.25");

    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items).toEqual([
      { productId: "p-pack", boxes: 0, pieces: 1, qty: 1 },
    ]);
  });

  it("a second UNIT scan merges as a piece (2 pcs, 2.50); a BOX scan then adds a whole box", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("400500600028");
    await scan("400500600028");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("0 boxes + 2 pcs"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
    await scan("400500600011");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("1 box + 2 pcs"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$32.50");
  });

  it("a BOX-code scan is one whole box at 30.00", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("400500600011");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("1 box"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$30.00");
  });

  it("a box/piece stepper on the till line adjusts the split and the price; it never steps to zero", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("400500600011"); // 1 box = 30.00
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Add a piece to Sample Cola 24pk" }));
    expect(lines()[0]).toHaveTextContent("1 box + 1 pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$31.25");
    fireEvent.click(screen.getByRole("button", { name: "Remove a box from Sample Cola 24pk" }));
    expect(lines()[0]).toHaveTextContent("0 boxes + 1 pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$1.25");
    // the last piece cannot be stepped away (the × button removes a line)
    expect(
      screen.getByRole("button", { name: "Remove a piece from Sample Cola 24pk" }),
    ).toBeDisabled();
    // 23 more pieces roll over into a box
    for (let i = 0; i < 23; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add a piece to Sample Cola 24pk" }));
    }
    expect(lines()[0]).toHaveTextContent("1 box");
    expect(lines()[0]).not.toHaveTextContent("pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$30.00");
  });

  it("a plain (not boxed) line gets a +/- quantity stepper", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Add one Sample Cola" }));
    expect(lines()[0]).toHaveTextContent("× 2");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$5.00");
    fireEvent.click(screen.getByRole("button", { name: "Remove one Sample Cola" }));
    expect(screen.getByRole("button", { name: "Remove one Sample Cola" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Sample Cola" })).toBeInTheDocument(); // the × stays
  });
});

describe("B1206 extra: the SAME code scanned twice quickly counts both", () => {
  it("two quick scans of one code are quantity 2 (identical lookups must not collapse into one add)", async () => {
    const reply = deferred<unknown>();
    barcodeFor["200000000001"] = () => reply.promise;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await scan("200000000001");
    reply.resolve(COLA);
    await waitFor(() => expect(lines()).toHaveLength(1));
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$5.00");
  });

  it("a typed quantity multiplies only the scan after it, even with the first still in flight", async () => {
    const reply = deferred<unknown>();
    barcodeFor["200000000001"] = () => reply.promise;
    barcodeFor["200000000002"] = () => CHIPS;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await scan("4");
    await scan("200000000002");
    reply.resolve(COLA);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(lines()[1]).toHaveTextContent("× 4");
  });
});

describe("D5: a 1-3 digit entry is a code FIRST when a product matches it exactly", () => {
  it("'42' that is a product's exact PLU adds that product (not a x42 multiplier)", async () => {
    barcodeFor["42"] = () => COLA;
    renderWithProviders(<CounterSaleScreen />);
    await scan("42");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
    expect(screen.queryByTestId("pending-qty")).toBeNull();
  });

  it("'3' with no exact match is still a quantity for the next scan", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderWithProviders(<CounterSaleScreen />);
    await scan("3");
    expect(screen.getByTestId("pending-qty")).toHaveTextContent("×3");
    await scan("200000000001");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 3"));
    expect(screen.queryByTestId("pending-qty")).toBeNull();
  });

  it("a fuzzy (name/sku substring) hit for '3' is NOT exact: it stays a quantity", async () => {
    listFor["3"] = () => [{ ...CHIPS, name: "Sample 3-pack Chips" }];
    renderWithProviders(<CounterSaleScreen />);
    await scan("3");
    await waitFor(() => expect(screen.getByTestId("pending-qty")).toHaveTextContent("×3"));
    expect(lines()).toHaveLength(0);
    expect(screen.queryByTestId("counter-scan-picker")).toBeNull();
  });

  it("a lookup ERROR on a short entry says it could not look up the code (never 'No product found')", async () => {
    barcodeFor["42"] = () => Promise.reject({ response: { status: 500, data: {} } });
    renderWithProviders(<CounterSaleScreen />);
    await scan("42");
    expect(await screen.findByTestId("counter-scan-error")).toHaveTextContent(/couldn't look up/i);
    expect(screen.queryByText(/No product found/)).toBeNull();
  });
});

describe("D6: the receipt is on screen BEFORE it prints", () => {
  const printSpy = jest.fn();
  beforeEach(() => {
    printSpy.mockReset();
    window.print = printSpy;
    window.localStorage.setItem("rf.counterSale.autoPrint", "1");
    barcodeFor["200000000001"] = () => COLA;
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
  });
  const ring = async (name: string | RegExp) => {
    renderWithProviders(<CounterSaleScreen />);
    await waitFor(() => expect(screen.getByLabelText("Print receipt automatically")).toBeChecked());
    await scan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: name }));
  };

  it("Complete sale: window.print runs with the receipt rendered", async () => {
    let receiptShown = false;
    printSpy.mockImplementationOnce(() => {
      receiptShown = screen.queryByTestId("counter-sale-receipt") !== null;
    });
    await ring("Complete sale");
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(receiptShown).toBe(true);
  });

  it("Complete & next sale: the receipt renders and prints once, THEN the till resets", async () => {
    let receiptShown = false;
    printSpy.mockImplementationOnce(() => {
      receiptShown = screen.queryByTestId("counter-sale-receipt") !== null;
    });
    await ring(/Complete & next sale/);
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(receiptShown).toBe(true);
    await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
  });
});

describe("pay guard: a sale never posts without the last scanned item", () => {
  const completeBtns = () => [
    screen.getByRole("button", { name: "Complete sale" }),
    screen.getByRole("button", { name: /Complete & next sale/ }),
  ];

  it("(a) scan then immediately Pay: no POST until the lookup resolves, and the POST includes that line", async () => {
    const reply = deferred<unknown>();
    barcodeFor["200000000001"] = () => reply.promise;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    expect(screen.getByTestId("counter-scan-busy")).toHaveTextContent("Adding scanned items");
    completeBtns().forEach((b) => expect(b).toBeDisabled());
    // the Enter key in the tender field must not post either
    const tender = screen.getByLabelText("Amount tendered");
    fireEvent.change(tender, { target: { value: "20" } });
    fireEvent.keyDown(tender, { key: "Enter" });
    fireEvent.click(completeBtns()[0]);
    expect(mutateAsync).not.toHaveBeenCalled();

    reply.resolve(COLA);
    await waitFor(() => expect(lines()).toHaveLength(1));
    await waitFor(() => expect(completeBtns()[0]).toBeEnabled());
    expect(screen.queryByTestId("counter-scan-busy")).toBeNull();
    fireEvent.click(completeBtns()[0]);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items).toEqual([{ productId: "p-cola", qty: 1 }]);
  });

  it("(b) a scan whose lookup errors keeps Pay blocked until it is Retried or Skipped", async () => {
    let healthy = false;
    barcodeFor["200000000001"] = () =>
      healthy ? COLA : Promise.reject({ response: { status: 503, data: {} } });
    renderWithProviders(<CounterSaleScreen />);
    const alert = await (async () => {
      await scan("200000000001");
      return screen.findByTestId("counter-scan-error");
    })();
    completeBtns().forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(within(alert).getByRole("button", { name: "Skip this scan" }));
    await waitFor(() => expect(completeBtns()[0]).toBeEnabled());

    await scan("200000000001");
    const alert2 = await screen.findByTestId("counter-scan-error");
    completeBtns().forEach((b) => expect(b).toBeDisabled());
    healthy = true;
    fireEvent.click(within(alert2).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    await waitFor(() => expect(completeBtns()[0]).toBeEnabled());
  });

  it("an open picker blocks Pay until a product is chosen or the picker is cancelled", async () => {
    listFor["COLA"] = () => [COLA, CHIPS];
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const picker = await screen.findByTestId("counter-scan-picker");
    completeBtns().forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(completeBtns()[0]).toBeEnabled());
  });
});

describe("B1208 nit: a UNIT multiplier at or over the pack size is labelled normalized", () => {
  beforeEach(() => {
    barcodeFor["400500600028"] = () => PACK24;
  });

  it("x30 UNIT scans on a 24-pack read '1 box + 6 pcs' (not '0 boxes + 30 pcs') and post the normalized split", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("30"); // a quantity for the next scan
    await scan("400500600028");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("1 box + 6 pcs");
    expect(lines()[0]).not.toHaveTextContent("30 pcs");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$37.50"); // 30.00 + 6 x 1.25

    fireEvent.click(screen.getByRole("button", { name: "$50" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items).toEqual([
      { productId: "p-pack", boxes: 1, pieces: 6, qty: 30 },
    ]);
  });
});

describe("B1219 on the counter: a fuzzy scan asks 'Did you mean ...?' and never auto-adds", () => {
  const picker = () => screen.findByRole("group", { name: /did you mean/i });
  const payButtons = () => [
    screen.getByRole("button", { name: "Complete sale" }),
    screen.getByRole("button", { name: /Complete & next sale/ }),
  ];

  it("ONE fuzzy hit: 'Did you mean <name>?' with Add and Cancel; nothing is added and Pay is blocked", async () => {
    listFor["COLA"] = () => [COLA];
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const group = await picker();
    expect(group).toHaveTextContent("Did you mean Sample Cola?");
    expect(within(group).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(lines()).toHaveLength(0); // never auto-added
    payButtons().forEach((b) => expect(b).toBeDisabled());
  });

  it("Add confirms the suggestion: one line, the picker is gone, Pay is back", async () => {
    listFor["COLA"] = () => [COLA];
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(within(await picker()).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
    await waitFor(() => expect(payButtons()[0]).toBeEnabled());
  });

  it("Cancel and Escape both add nothing and release Pay", async () => {
    listFor["COLA"] = () => [COLA];
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(within(await picker()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(payButtons()[0]).toBeEnabled());
    expect(lines()).toHaveLength(0);

    await scan("COLA");
    await picker();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull());
    expect(lines()).toHaveLength(0);
    await waitFor(() => expect(payButtons()[0]).toBeEnabled());
  });

  it("SEVERAL hits: 'Did you mean one of these?' lists every match, one Add each; Pay is blocked", async () => {
    listFor["COLA"] = () => [COLA, CHIPS];
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const group = await picker();
    expect(group).toHaveTextContent("Did you mean one of these?");
    expect(within(group).getByRole("button", { name: "Add Sample Cola" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Add Sample Chips" })).toBeInTheDocument();
    payButtons().forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(within(group).getByRole("button", { name: "Add Sample Chips" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Chips");
  });

  it("an exact code still adds at once, with no picker", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });
});

describe("scan queue: edge cases around the picker and removal", () => {
  it("a scan while the picker is open waits behind it (Pay stays blocked), then lands once the picker is resolved", async () => {
    listFor["COLA"] = () => [COLA];
    barcodeFor["200000000002"] = () => CHIPS;
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await screen.findByRole("group", { name: /did you mean/i });
    await scan("200000000002"); // arrives while the picker is open
    await new Promise((r) => setTimeout(r, 30));
    expect(lines()).toHaveLength(0); // queued behind the open suggestion, not applied around it
    expect(screen.getByRole("button", { name: "Complete sale" })).toBeDisabled();

    fireEvent.click(
      within(screen.getByRole("group", { name: /did you mean/i })).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Chips");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Complete sale" })).toBeEnabled(),
    );
  });

  it("removing a line while a later scan is pending: the removed line stays gone and the pending scan still lands", async () => {
    const chipsReply = deferred<unknown>();
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["200000000002"] = () => chipsReply.promise;
    listFor["200000000002"] = () => chipsReply.promise.then((p) => [p]);
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    await scan("200000000002"); // pending
    fireEvent.click(screen.getByRole("button", { name: "Remove Sample Cola" }));
    expect(lines()).toHaveLength(0);

    chipsReply.resolve(CHIPS);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Chips");
    expect(screen.queryByText(/Sample Cola/)).toBeNull();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$4.00");
  });

  it("removing the line a pending scan is for: the scan re-adds it fresh (no stale merge into a ghost line)", async () => {
    const colaReply = deferred<unknown>();
    barcodeFor["200000000001"] = () => COLA;
    renderWithProviders(<CounterSaleScreen />);
    await scan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    barcodeFor["200000000001"] = () => colaReply.promise;
    listFor["200000000001"] = () => colaReply.promise.then((p) => [p]);
    await scan("200000000001"); // a second Cola, pending
    fireEvent.click(screen.getByRole("button", { name: "Remove Sample Cola" }));
    colaReply.resolve(COLA);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("× 1");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
  });
});
