import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { computeLineSubtotal } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import { renderTill } from "@/test-utils/render-till";
import { CounterLineRow } from "./CounterLineRow";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-853 (SA-1021 as amended by SA-1022, SA-940 rule 19): a counter line shows the SAME `PriceHistoryButton` as Create Order
 * when a NAMED customer is picked and the person may edit prices (`mayEditPrices`, the one gate). A walk-in, no customer, or no
 * grant shows nothing and makes no history request. "Use this price" goes through `editPrice` -> `applyPriceEdit`, the path a
 * typed price takes: the dialog asks for the special-price reason, Charge asks again if the customer changes, the locked guard holds, and nothing prefills the till.
 */

type MockUser = { id: string; tenantSlug: string; role?: string } | null | undefined;
let mockUser: MockUser;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: mockUser }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 10,
  priceTier2: 8,
  priceTier3: 6,
  unit: "each",
  unitsPerBox: null,
};
const JUICE = {
  id: "p-juice",
  name: "Juice",
  pricePerUnit: 5,
  priceTier2: 4,
  priceTier3: 3,
  unit: "each",
  unitsPerBox: null,
};
/** a 12-pack at 24.00 a box */
const WATER = {
  id: "p-water",
  name: "Water",
  pricePerUnit: 24,
  priceTier2: 20,
  priceTier3: 18,
  unit: "case",
  unitsPerBox: 12,
};
/** a 24-pack at 48.00 a box, its base word "each": the line's unit hint must still read as the case */
const CRATE = {
  id: "p-crate",
  name: "Crate",
  pricePerUnit: 48,
  priceTier2: 40,
  priceTier3: 36,
  unit: "each",
  unitsPerBox: 24,
};
const PRODUCTS: Record<string, unknown> = { COLA, JUICE, WATER, CRATE };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true },
}));
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 2 };
const BETA = { id: "c-beta", businessName: "Beta Deli", pricingTier: 1 };
const WALKIN = { id: "c-walkin", businessName: "Walk-in Record", pricingTier: 1, isWalkIn: true };
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME, BETA, WALKIN] } }),
  useCustomerPrices: (customerId: string | undefined) =>
    jest.requireActual("@tanstack/react-query").useQuery({
      queryKey: ["customer-prices", customerId],
      queryFn: () =>
        jest
          .requireMock("@/lib/api-client")
          .apiClient.get(`/customers/${customerId}/prices`)
          .then((r: { data: unknown }) => r.data),
      enabled: !!customerId,
    }),
}));
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

const get = apiClient.get as unknown as jest.Mock;
const ADMIN = { id: "u-a", tenantSlug: "acme", role: "TENANT_ADMIN" };
const OPERATOR = { id: "u-o", tenantSlug: "acme", role: "OPERATOR" };

const historyRow = (over: Record<string, unknown>) => ({
  date: "2026-09-20T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 9,
  unitLabel: "each",
  unitsPerBox: null,
  salePack: 1,
  qty: 2,
  boxes: 0,
  pieces: 2,
  avgCostAtSale: 4,
  invoiceId: "inv-1",
  invoiceNumber: "INV-0001",
  orderId: "ord-1",
  orderNumber: "ORD-0001",
  priceType: null,
  ...over,
});
/** what the history endpoint answers per product: one usable price each, and Water also a different-pack price */
const HISTORY: Record<string, unknown[]> = {
  "p-cola": [
    historyRow({ unitPrice: 9 }),
    historyRow({ unitPrice: 8.004, invoiceNumber: "INV-2" }),
  ],
  "p-juice": [historyRow({ unitPrice: 4.5 })],
  "p-crate": [historyRow({ unitPrice: 36, unitLabel: "case", unitsPerBox: 24, salePack: 24 })],
  "p-water": [
    historyRow({ unitPrice: 21, unitLabel: "case", unitsPerBox: 12, salePack: 12 }),
    historyRow({
      unitPrice: 40,
      unitLabel: "case",
      unitsPerBox: 24,
      salePack: 24,
      invoiceNumber: "INV-3",
    }),
  ],
};
const HISTORY_URL = /^\/customers\/[^/]+\/products\/[^/]+\/price-history$/;
const historyCalls = () => get.mock.calls.filter((c) => HISTORY_URL.test(String(c[0])));

const PARKED = "/orders/counter-sale/parked";
const parkedPayload = () => ({
  lines: [
    {
      tempId: "r1",
      productId: "p-cola",
      name: "Cola",
      unitPrice: 10,
      qty: 1,
      listPrice: 10,
      unit: "each",
      priceType: "STANDARD",
      tierPrices: { pricePerUnit: 10, priceTier2: 8 },
    },
  ],
  customer: { id: "c-beta", businessName: "Beta Deli", pricingTier: 1 },
  method: "CARD",
  tendered: "",
  reference: "",
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockUser = ADMIN;
  get.mockImplementation((url: string) => {
    const m = /^\/customers\/[^/]+\/products\/([^/]+)\/price-history$/.exec(url);
    if (m) return Promise.resolve({ data: { rows: HISTORY[m[1]] ?? [], summaries: [] } });
    if (url === PARKED)
      return Promise.resolve({
        data: {
          data: [
            {
              id: "a",
              label: "Hold A",
              registerKey: "main",
              createdAt: "2026-10-08T18:41:00.000Z",
              expiresAt: new Date(Date.now() + 72_000_000).toISOString(),
              lineCount: 1,
              customerName: "Beta Deli",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      });
    return url.endsWith("/statement")
      ? Promise.resolve({ data: { outstandingAmount: 0, overdueAmount: 0, autoApplyCredit: 0 } })
      : url.startsWith("/customers/")
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: { taxRate: 0 } });
  });
  (apiClient.post as unknown as jest.Mock).mockImplementation((url: string) =>
    /\/parked\/.+\/resume$/.test(url)
      ? Promise.resolve({ data: { id: "a", label: "x", createdAt: "t", payload: parkedPayload() } })
      : Promise.reject(new Error(`unexpected POST ${url}`)),
  );
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 9,
    paid: 9,
    balanceDue: 0,
    change: 0,
    paymentRecorded: true,
  });
});

const NAME: Record<string, string> = {
  COLA: "Cola",
  JUICE: "Juice",
  WATER: "Water",
  CRATE: "Crate",
};
const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `Remove ${NAME[text]}` })).toBeInTheDocument(),
  );
};
const pick = async (name: string) => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "a" } });
  fireEvent.click(screen.getByRole("option", { name }));
  await waitFor(() => expect(screen.queryByTestId("counter-reprice-busy")).toBeNull());
};
const total = () => screen.getByTestId("running-total");
const lineOf = (name: string) =>
  screen.getByRole("button", { name: `Remove ${name}` }).closest("li") as HTMLElement;
/** how many "Price history" buttons the cart shows (a count, so a missing button reads Expected 1, Received 0) */
const historyButtons = () => screen.queryAllByRole("button", { name: "Price history" });
const openHistory = async (name: string) => {
  expect(within(lineOf(name)).queryAllByRole("button", { name: "Price history" })).toHaveLength(1);
  fireEvent.click(within(lineOf(name)).getByRole("button", { name: "Price history" }));
  return screen.findByRole("dialog", { name: "Price history" });
};
const priceBtn = (dialog: HTMLElement, price: string) =>
  within(dialog).findByRole("button", { name: `Use this price (${price})` });
/** Opens the panel for `name`, taps Use on the `price` row and waits for the price dialog it opens. */
const chooseHistoryPrice = async (name: string, price: string) => {
  const panel = await openHistory(name);
  fireEvent.click(await priceBtn(panel, price));
  await waitFor(() =>
    expect(screen.queryAllByRole("dialog", { name: `Change the price for ${name}` })).toHaveLength(
      1,
    ),
  );
};
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });
const interactiveCount = (name: string) => lineOf(name).querySelectorAll("button, input").length;

describe("W-853 the history button on a counter line", () => {
  it("shows one history button per line once a named customer is picked, and asks nothing until then", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await scan("JUICE");
    expect(historyButtons()).toHaveLength(0);
    await pick("Beta Deli");
    expect(historyButtons()).toHaveLength(2);
    expect(within(lineOf("Cola")).queryAllByRole("button", { name: "Price history" })).toHaveLength(
      1,
    );
    expect(
      within(lineOf("Juice")).queryAllByRole("button", { name: "Price history" }),
    ).toHaveLength(1);
  });

  it("a walk-in (no customer, or the system walk-in record) shows nothing and makes no history request", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    expect(historyButtons()).toHaveLength(0);
    await pick("Walk-in Record");
    await scan("JUICE");
    expect(historyButtons()).toHaveLength(0);
    expect(interactiveCount("Cola")).toBe(6); // remove, 2 steppers, qty, Change price, Add note: nothing new
    expect(historyCalls()).toHaveLength(0);
  });

  it.each([
    ["a SUPER_ADMIN", { ...ADMIN, role: "SUPER_ADMIN" }],
    ["a DRIVER", { ...ADMIN, role: "DRIVER" }],
    ["no user", undefined],
  ] as [string, MockUser][])(
    "%s (canEditPrices false) gets no button, no tab stop and no history request",
    async (_who, user) => {
      mockUser = user;
      renderTill(<CounterSaleScreen />);
      await scan("COLA");
      await pick("Beta Deli");
      expect(historyButtons()).toHaveLength(0);
      expect(interactiveCount("Cola")).toBe(5); // remove, 2 steppers, qty, Add note
      expect(lineOf("Cola").innerHTML).not.toMatch(/Price history/);
      expect(historyCalls()).toHaveLength(0);
    },
  );

  it("an OPERATOR gets it too: the button is one more tab stop beside Change price", async () => {
    mockUser = OPERATOR;
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    expect(historyButtons()).toHaveLength(1);
    expect(interactiveCount("Cola")).toBe(7);
    expect(historyButtons()[0]).toBeEnabled();
  });

  it("choosing Walk-in removes the button; picking another customer reads that customer's history", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await waitFor(() =>
      expect(historyCalls().map((c) => c[0])).toContain(
        "/customers/c-beta/products/p-cola/price-history",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    await waitFor(() => expect(historyButtons()).toHaveLength(0));
    get.mockClear();
    await pick("Acme Cafe");
    expect(historyButtons()).toHaveLength(1);
    await waitFor(() =>
      expect(historyCalls().map((c) => c[0])).toEqual([
        "/customers/c-acme/products/p-cola/price-history",
      ]),
    );
  });

  it("a restored parked sale for a named customer shows the button, and Use opens the price dialog", async () => {
    renderTill(<CounterSaleScreen />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Parked (1)" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Parked (1)" }));
    await screen.findByRole("dialog", { name: "Parked sales" });
    fireEvent.click(screen.getByRole("button", { name: "Resume Hold A" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove Cola" })).not.toBeNull(),
    );
    expect(historyButtons()).toHaveLength(1);
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(total()).toHaveTextContent("$9.00"));
    expect(within(lineOf("Cola")).getByTestId("line-price-chip")).toHaveTextContent(
      "Price changed",
    );
  });

  it("a line with no product (an unlisted line) gets no history button", () => {
    renderWithProviders(
      <ul>
        <CounterLineRow
          line={{ tempId: "u1", productId: "", name: "Loose item", unitPrice: 3, qty: 1 }}
          locked={false}
          onStep={jest.fn()}
          onRemove={jest.fn()}
          onNote={jest.fn()}
          onQty={() => true}
          canEditPrices
          historyCustomerId="c-beta"
        />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "Change price for Loose item" })).toBeEnabled();
    expect(historyButtons()).toHaveLength(0);
    expect(historyCalls()).toHaveLength(0);
  });
});

describe("W-853 the panel's pack rule, on the counter", () => {
  it("offers a price of the line's own pack and refuses one from a different pack", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await pick("Beta Deli");
    const dialog = await openHistory("Water");
    expect(await priceBtn(dialog, "$21.00")).toBeEnabled();
    expect(await priceBtn(dialog, "$40.00")).toBeDisabled();
  });
});

describe("W-853 Use this price opens the price dialog; Apply is the one write", () => {
  const priceDialog = (name = "Cola") =>
    screen.findByRole("dialog", { name: `Change the price for ${name}` });
  const priceField = () => screen.getByRole("textbox", { name: "Price per item" });
  /** Charges the sale and returns the first item sent. */
  const charge = async () => {
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    return mutateAsync.mock.calls[0][0].dto.items[0] as Record<string, unknown>;
  };

  it("opens the dialog with the history price in the number field, and nothing is priced until Apply", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    expect(priceField()).toHaveValue("9.00");
    await waitFor(() => expect(priceField()).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull();
    expect(total()).toHaveTextContent("$10.00");
    expect(screen.queryAllByTestId("line-price-chip")).toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("Apply writes the line once, exactly as a typed price does for the same number", async () => {
    const first = renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    fireEvent.click(screen.getByRole("button", { name: "Change price for Cola" }));
    await priceDialog();
    expect(priceField()).toHaveValue(""); // a plain Change price opens empty
    fireEvent.change(priceField(), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const typedTotal = total().textContent;
    const typedChip = within(lineOf("Cola")).getByTestId("line-price-chip").textContent;
    const typedItem = await charge();
    first.unmount();
    mutateAsync.mockClear();

    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total().textContent).toBe(typedTotal);
    expect(total()).toHaveTextContent("$9.00");
    expect(within(lineOf("Cola")).getByTestId("line-price-chip").textContent).toBe(typedChip);
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(1);
    expect(await charge()).toEqual(typedItem);
  });

  it("SA-942 MUST 13: a history BOX price on a 24-pack line of 1 box + 6 pieces is computeLineSubtotal, never qty x price", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("CRATE");
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Add a piece to Crate" }));
    }
    await waitFor(() => expect(total()).toHaveTextContent("$60.00")); // 48 + 6 x (48/24)
    await pick("Beta Deli");
    await chooseHistoryPrice("Crate", "$36.00");
    expect(screen.getByRole("textbox", { name: "Price per box" })).toHaveValue("36.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const builder = computeLineSubtotal({
      unitPrice: 36,
      qty: 30,
      boxes: 1,
      pieces: 6,
      unitsPerBox: 24,
    });
    expect(builder).toBe(45); // 36 + 6 x 1.50, not 30 x 36
    expect(total()).toHaveTextContent("$45.00");
    expect(await charge()).toMatchObject({
      productId: "p-crate",
      boxes: 1,
      pieces: 6,
      qty: 30,
      unitPrice: 36,
    });
  });

  it("a dialog left on Percent off, with a reason and an error in it, opens from history clean: 9.00 is a price, not 9% off", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Acme Cafe");
    fireEvent.click(screen.getByRole("button", { name: "Change price for Cola" }));
    await priceDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Percent off" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Percent off" }), {
      target: { value: "abc" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (required)" }), {
      target: { value: "Left over" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await chooseHistoryPrice("Cola", "$9.00");
    expect(priceField()).toHaveValue("9.00");
    expect(screen.getByRole("textbox", { name: "Reason (required)" })).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: "Set price" })).toBeChecked();
  });

  it("SA-1021 C9(b): a history price applied for a plain customer, then a special-tier customer: Charge asks for the reason and nothing is sent", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await pick("Acme Cafe");
    await waitFor(() => expect(screen.getByTestId("counter-reprice-note")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a reason for Cola. Acme Cafe has a special price on it.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("Cancel from a history Use leaves the line untouched, and the next plain Change price opens empty", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total()).toHaveTextContent("$10.00");
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change price for Cola" }));
    await priceDialog();
    expect(priceField()).toHaveValue("");
  });

  it("using the same price twice opens the dialog twice", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await chooseHistoryPrice("Cola", "$9.00");
    expect(priceField()).toHaveValue("9.00");
  });

  it("a special-tier customer's dialog asks for the reason: no reason, no write, no POST; with one it is sent", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Acme Cafe");
    await chooseHistoryPrice("Cola", "$9.00"); // Acme's price is 8.00
    expect(screen.getByRole("textbox", { name: "Reason (required)" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason/i);
    expect(screen.getByRole("dialog", { name: "Change the price for Cola" })).toBeInTheDocument();
    expect(total()).toHaveTextContent("$8.00");
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (required)" }), {
      target: { value: "Matched last invoice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total()).toHaveTextContent("$9.00");
    expect(await charge()).toMatchObject({ priceReason: "Matched last invoice" });
  });

  it("a history price within half a cent of the special price needs no reason and stays a plain line", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Acme Cafe");
    await chooseHistoryPrice("Cola", "$8.00"); // 8.004 from an old invoice
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
    expect(total()).toHaveTextContent("$8.00");
    expect(await charge()).not.toHaveProperty("priceReason");
  });

  it("changes nothing while a sale is in flight: the button is off and a Use from an open panel opens no dialog", async () => {
    mutateAsync.mockReturnValue(new Promise(() => {}));
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    const dialog = await openHistory("Cola");
    const use = await priceBtn(dialog, "$9.00");
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(within(lineOf("Cola")).getByRole("button", { name: "Price history" })).toBeDisabled();
    fireEvent.click(use);
    expect(screen.queryByRole("dialog", { name: "Change the price for Cola" })).toBeNull();
    expect(total()).toHaveTextContent("$10.00");
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
  });

  it("focus: Escape in the price dialog hands it to the scan field; Escape in the panel leaves it on the history button", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await chooseHistoryPrice("Cola", "$9.00");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Change the price for Cola" }), {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    expect(total()).toHaveTextContent("$10.00");

    await openHistory("Cola");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull());
    await waitFor(() =>
      expect(within(lineOf("Cola")).getByRole("button", { name: "Price history" })).toHaveFocus(),
    );
  });
});

describe("W-853 structure: one component, no local copy of its rules", () => {
  const dir = __dirname;
  const counterSources = () =>
    fs
      .readdirSync(dir)
      .filter((f) => /^(Counter|useCounter|counter-).*\.tsx?$/.test(f) && !/\.test\./.test(f))
      .map((f) => ({ f, src: fs.readFileSync(path.join(dir, f), "utf8") }));

  it("the counter row imports PriceHistoryButton from components/PriceHistory", () => {
    const row = fs.readFileSync(path.join(dir, "CounterLineRow.tsx"), "utf8");
    expect(row).toMatch(
      /import \{[^}]*\bPriceHistoryButton\b[^}]*\} from "@\/components\/PriceHistory"/,
    );
  });

  it("no counter file defines its own pack rule or reads /price-history itself", () => {
    const offenders = counterSources()
      .filter(({ src }) =>
        /function canUseHistoryPrice|const canUseHistoryPrice|\/price-history/.test(src),
      )
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
