import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1187 PR-2b: the till's lines can be dragged into any order. The cart is a local list and its array order is the order the
 * sale is sent in (the server stores `position` by array index and the invoice follows), so a move is a reorder of the array:
 * no request. After a drag, a keyboard move or an Undo, focus goes back to the scan box (the till's standing rule). A scan
 * burst never moves, picks up or drops a line, and a repeat scan of a product already in the cart raises its quantity IN
 * PLACE; only a new product goes to the end.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
type Toast = { title: string; action?: { label: string; onClick: () => void } };
const mockToast = jest.fn((o: Toast): string => {
  void o;
  return "t1";
});
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

const P = (id: string, name: string) => ({
  id,
  name,
  pricePerUnit: 2,
  unit: "each",
  unitsPerBox: null,
});
const PRODUCTS: Record<string, unknown> = {
  COLA: P("p-cola", "Cola"),
  WATER: P("p-water", "Water"),
  JUICE: P("p-juice", "Juice"),
  cola12345678: P("p-cola", "Cola"), // SA-1138 T3: a lowercase-led code
  "4006381333931": P("p-cola", "Cola"), // a real-shaped code that resolves to the product already in the cart
};
const mockLookups: string[] = [];
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    mockLookups.push(code);
    return PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true };
  },
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
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

let now = 1000;
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  now += 100_000; // the scan-safety guard remembers the last key across tests: the clock only moves forward
  jest.spyOn(performance, "now").mockImplementation(() => now);
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  };
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 0,
    paid: 0,
    balanceDue: 0,
    paymentRecorded: true,
  });
});
let online = true;
beforeEach(() => {
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});
afterEach(() => {
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
  jest.restoreAllMocks();
});

/** A person's rhythm between keys. */
const human = () => {
  now += 150;
};
const scanBox = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const scan = async (text: string) => {
  fireEvent.change(scanBox(), { target: { value: text } });
  fireEvent.submit(scanBox().closest("form")!);
  await waitFor(() => expect(scanBox().value).toBe(""));
};
const rows = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");
const names = () => rows().map((t) => /^(Cola|Water|Juice)/.exec(t)?.[1]);
const handle = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Move ${name}, line`) });
const lastToast = (): Toast => mockToast.mock.calls[mockToast.mock.calls.length - 1][0];

async function cart(...codes: string[]) {
  renderTill(<CounterSaleScreen />);
  for (const c of codes) await scan(c);
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}
async function altDown(name: string) {
  human();
  await act(async () => {
    fireEvent.keyDown(handle(name), { key: "ArrowDown", code: "ArrowDown", altKey: true });
  });
}

describe("CounterSaleScreen: drag a line into any order (W-1187 PR-2b)", () => {
  it("every line of a two-line cart has a labelled handle; a one-line cart has none", async () => {
    await cart("COLA");
    expect(screen.queryByRole("button", { name: /^Move Cola/ })).toBeNull();
    await scan("WATER");
    expect(handle("Cola")).toHaveAccessibleName("Move Cola, line 1 of 2");
    expect(handle("Water")).toHaveAccessibleName("Move Water, line 2 of 2");
  });

  it("the handle sits in the row's own slot, fully visible: absolute, 24 px wide, no negative margin (#4292)", async () => {
    await cart("COLA", "WATER");
    const slot = handle("Cola").parentElement!;
    expect(slot.className).toContain("absolute inset-y-0 left-0");
    expect(slot.className).toContain("[&>button]:ml-0");
    expect(slot.className).toContain("[&>button]:w-6");
    expect(handle("Cola").className).toContain("h-11"); // 44 px target
    expect(slot.parentElement!.className).toContain("relative");
    expect(slot.parentElement!.className).toContain("pl-8");
  });

  it("Alt+ArrowDown moves the line, says 'Moved Cola to line 2' with Undo, and focus goes back to the scan box", async () => {
    await cart("COLA", "WATER");
    handle("Cola").focus();
    await altDown("Cola");
    expect(names()).toEqual(["Water", "Cola"]);
    expect(lastToast().title).toBe("Moved Cola to line 2");
    expect(lastToast().action?.label).toBe("Undo");
    await waitFor(() => expect(scanBox()).toHaveFocus());
  });

  it("Undo puts the order back and focus returns to the scan box", async () => {
    await cart("COLA", "WATER");
    handle("Cola").focus();
    await altDown("Cola");
    handle("Water").focus();
    act(() => lastToast().action!.onClick());
    expect(names()).toEqual(["Cola", "Water"]);
    await waitFor(() => expect(scanBox()).toHaveFocus());
  });

  it("Space, ArrowDown, Space on the handle moves a line too, then focus is the scan box", async () => {
    // jsdom has no layout: give each row a 50 px box by its place so dnd-kit can tell which row a key press lands on
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const li = this.closest("li");
      const i = li ? Array.from(li.parentElement!.children).indexOf(li) : 0;
      const top = li ? i * 50 : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 200,
        bottom: top + 50,
        width: 200,
        height: 50,
        toJSON() {},
      } as DOMRect;
    });
    await cart("COLA", "WATER", "JUICE");
    const h = handle("Cola");
    h.focus();
    human();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    });
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });
    await waitFor(() => expect(names()).not.toEqual(["Cola", "Water", "Juice"]));
    await waitFor(() => expect(scanBox()).toHaveFocus());
  });

  it("the sale is sent in the dragged order", async () => {
    await cart("COLA", "WATER", "JUICE");
    handle("Juice").focus();
    human();
    await act(async () => {
      fireEvent.keyDown(handle("Juice"), { key: "ArrowUp", code: "ArrowUp", altKey: true });
    });
    human();
    await act(async () => {
      fireEvent.keyDown(handle("Juice"), { key: "ArrowUp", code: "ArrowUp", altKey: true });
    });
    expect(names()).toEqual(["Juice", "Cola", "Water"]);
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.items.map((i: { productId: string }) => i.productId)).toEqual([
      "p-juice",
      "p-cola",
      "p-water",
    ]);
  });

  it("a repeat scan raises the quantity IN PLACE after a drag; a new product goes to the end", async () => {
    await cart("COLA", "WATER");
    handle("Cola").focus();
    await altDown("Cola"); // Water, Cola
    await scan("WATER"); // Water already first: quantity up, position unchanged
    expect(names()).toEqual(["Water", "Cola"]);
    expect(rows()[0]).toMatch(/× 2/);
    await scan("JUICE");
    expect(names()).toEqual(["Water", "Cola", "Juice"]);
  });

  it("a digit burst + Enter while a handle holds focus is a scan: the code reaches the scan box, nothing moves", async () => {
    await cart("COLA", "WATER");
    handle("Water").focus();
    await userEvent.keyboard("{Shift>}J{/Shift}", { delay: null }); // a capital: the till routes it to the scan box
    expect(scanBox()).toHaveFocus();
    await userEvent.keyboard("UICE{Enter}", { delay: null });
    await waitFor(() => expect(names()).toEqual(["Cola", "Water", "Juice"]));
    expect(mockToast).not.toHaveBeenCalled(); // no "Moved ..."
  });

  it("SD-T3: a lowercase-led code + Enter typed on a line handle (not picked up) is looked up once, whole; the order stays", async () => {
    await cart("COLA", "WATER");
    mockLookups.length = 0;
    handle("Water").focus();
    const user = userEvent.setup({ delay: 5 });
    await user.keyboard("cola12345678{Enter}");
    await waitFor(() => expect(mockLookups.length).toBeGreaterThan(0));
    expect(mockLookups).toEqual(["cola12345678"]);
    await waitFor(() => expect(rows()[0]).toMatch(/× 2/));
    expect(names()).toEqual(["Cola", "Water"]);
    expect(mockToast).not.toHaveBeenCalled();
  });

  // SA-1138 TG8: a line picked up with Space, then a scan: the code is looked up once whole, the move ends, and a later
  // ArrowDown (focus in the scan box) moves no line.
  it.each(["4006381333931", "cola12345678"])(
    "TG8: a line picked up with Space, then a whole scan %s + Enter: looked up once, the move ends, ArrowDown moves nothing",
    async (code) => {
      jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        const li = this.closest("li");
        const i = li ? Array.from(li.parentElement!.children).indexOf(li) : 0;
        const top = li ? i * 50 : 0;
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 200,
          bottom: top + 50,
          width: 200,
          height: 50,
          toJSON() {},
        } as DOMRect;
      });
      await cart("COLA", "WATER", "JUICE");
      mockLookups.length = 0;
      const h = handle("Cola");
      h.focus();
      human();
      fireEvent.keyDown(h, { key: " ", code: "Space" });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(h).toHaveAttribute("aria-pressed", "true"); // picked up
      const user = userEvent.setup({ delay: 5 });
      await user.keyboard(`${code}{Enter}`);
      await waitFor(() => expect(mockLookups.filter((c) => c === code)).toHaveLength(1));
      expect(mockLookups).toEqual([code]);
      expect(h).not.toHaveAttribute("aria-pressed", "true"); // the move ended
      human();
      await act(async () => {
        fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
      });
      expect(names()).toEqual(["Cola", "Water", "Juice"]);
    },
  );

  it("a burst of arrow keys + Enter on a focused handle moves and picks up nothing", async () => {
    await cart("COLA", "WATER");
    const h = handle("Cola");
    h.focus();
    for (const code of ["ArrowDown", "ArrowDown", "ArrowUp", "Enter"]) {
      fireEvent.keyDown(h, { key: code, code });
      now += 2;
    }
    expect(names()).toEqual(["Cola", "Water"]);
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("a quantity change after a move keeps the order", async () => {
    await cart("COLA", "WATER");
    handle("Cola").focus();
    await altDown("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" }));
    expect(names()).toEqual(["Water", "Cola"]);
  });

  it("no handles while the sale is going out", async () => {
    let release!: (v: unknown) => void;
    mutateAsync.mockReturnValue(new Promise((r) => (release = r)));
    await cart("COLA", "WATER");
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Move Cola/ })).toBeNull();
    await act(async () => {
      release({ orderId: "o1", orderNumber: "ORD-1", paymentRecorded: true });
    });
  });

  // W-872: the Idempotency-Key belongs to the SALE (a ref made at the first Complete), never to the lines. A reorder after
  // an offline failure resends the same key; the server compares the cart as a multiset of lines (order-blind), so it
  // answers with the FIRST sale, whose order is the one stored.
  it("a reorder after an offline failure resends the SAME Idempotency-Key", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    await cart("COLA", "WATER");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    online = false;
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByText(/^No connection/);
    handle("Cola").focus();
    await altDown("Cola");
    expect(names()).toEqual(["Water", "Cola"]);
    online = true;
    mutateAsync.mockResolvedValueOnce({
      orderId: "o1",
      orderNumber: "ORD-1",
      paymentRecorded: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0].idempotencyKey).toBe(
      mutateAsync.mock.calls[0][0].idempotencyKey,
    );
    expect(
      mutateAsync.mock.calls[1][0].dto.items.map((i: { productId: string }) => i.productId),
    ).toEqual(["p-water", "p-cola"]);
  });

  it("an unknown outcome locks the cart: no handles, so the retry is the same body as the first", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503, data: {} } });
    await cart("COLA", "WATER");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    expect(screen.queryByRole("button", { name: /^Move Cola/ })).toBeNull();
  });
});

/**
 * #4293 gave the till ONE capture key listener (with the armed scan hand-over). The drag adds no second key listener and no
 * new focus owner on the till, and a drag (keyboard or pointer) neither arms, disarms nor swallows a scan: the whole code is
 * looked up once.
 */
describe("CounterSaleScreen: a drag and a scan never get in each other's way (W-1187 PR-2b, #4293)", () => {
  const layout = () =>
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const li = this.closest("li");
      const top = li ? Array.from(li.parentElement!.children).indexOf(li) * 50 : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 200,
        bottom: top + 50,
        width: 200,
        height: 50,
        toJSON() {},
      } as DOMRect;
    });
  const typeCode = async (code: string) => {
    const [first, ...rest] = code;
    await userEvent.keyboard(`{Shift>}${first}{/Shift}${rest.join("")}{Enter}`, { delay: null });
  };
  beforeEach(() => {
    mockLookups.length = 0;
  });

  it("the till keeps ONE keydown listener and no drag-owned focus call: the screen passes the list no scanTarget", () => {
    const src = fs.readFileSync(path.join(__dirname, "CounterSaleScreen.tsx"), "utf8");
    expect((src.match(/addEventListener\("keydown"/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/scanTarget/);
  });

  it("Ctrl+Z after a move at the till leaves the order alone: the toast's Undo button is the way back", async () => {
    await cart("COLA", "WATER");
    handle("Cola").focus();
    await altDown("Cola");
    expect(names()).toEqual(["Water", "Cola"]);
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(names()).toEqual(["Water", "Cola"]);
    act(() => lastToast().action!.onClick());
    expect(names()).toEqual(["Cola", "Water"]);
  });

  it("a scan typed while a keyboard drag is in progress is looked up once, whole; the drag ends and nothing moves", async () => {
    layout();
    await cart("COLA", "WATER");
    mockLookups.length = 0;
    const h = handle("Cola");
    h.focus();
    human();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h).toHaveAttribute("aria-pressed", "true");
    await typeCode("JUICE");
    await waitFor(() => expect(names()).toEqual(["Cola", "Water", "Juice"]));
    expect(mockLookups).toEqual(["JUICE"]);
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/^Moved /) }),
    );
  });

  it("a scan right after a keyboard drop is looked up once, whole, and the dropped order stays", async () => {
    layout();
    await cart("COLA", "WATER");
    mockLookups.length = 0;
    const h = handle("Cola");
    h.focus();
    human();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    });
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });
    await waitFor(() => expect(names()).toEqual(["Water", "Cola"]));
    await waitFor(() => expect(scanBox()).toHaveFocus());
    await typeCode("JUICE");
    await waitFor(() => expect(names()).toEqual(["Water", "Cola", "Juice"]));
    expect(mockLookups).toEqual(["JUICE"]);
  });

  it("a scan right after an Alt+Arrow move or an Undo is looked up once, whole", async () => {
    await cart("COLA", "WATER");
    mockLookups.length = 0;
    handle("Cola").focus();
    await altDown("Cola");
    await waitFor(() => expect(scanBox()).toHaveFocus());
    await typeCode("JUICE");
    await waitFor(() => expect(names()).toEqual(["Water", "Cola", "Juice"]));
    expect(mockLookups).toEqual(["JUICE"]);
    act(() => lastToast().action!.onClick());
    await waitFor(() => expect(scanBox()).toHaveFocus());
    await typeCode("COLA");
    await waitFor(() => expect(rows()[0]).toMatch(/× 2/));
    expect(mockLookups).toEqual(["JUICE", "COLA"]);
  });

  it("a pointer press on a handle before a scan does not swallow it: one lookup, whole code", async () => {
    await cart("COLA", "WATER");
    mockLookups.length = 0;
    fireEvent.pointerDown(handle("Cola"));
    fireEvent.pointerUp(handle("Cola"));
    handle("Cola").focus();
    await typeCode("JUICE");
    await waitFor(() => expect(names()).toEqual(["Cola", "Water", "Juice"]));
    expect(mockLookups).toEqual(["JUICE"]);
  });
});
