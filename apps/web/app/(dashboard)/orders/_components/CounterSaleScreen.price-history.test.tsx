import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-853 (SA-1021 as amended by SA-1022, SA-940 rule 19): a counter line shows the SAME `PriceHistoryButton` as Create Order
 * when a NAMED customer is picked and the person may edit prices (`mayEditPrices`, the one gate). A walk-in, no customer, or no
 * grant shows nothing and makes no history request. "Use this price" goes through `editPrice` -> `applyPriceEdit`, the path a
 * typed price takes: the special-price reason is asked at Charge, the locked guard holds, and nothing prefills the till.
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
const PRODUCTS: Record<string, unknown> = { COLA, JUICE, WATER };
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

const NAME: Record<string, string> = { COLA: "Cola", JUICE: "Juice", WATER: "Water" };
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
const useBtn = (dialog: HTMLElement, price: string) =>
  within(dialog).findByRole("button", { name: `Use this price (${price})` });
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

  it("a restored parked sale for a named customer shows the button, and Use applies through the price path", async () => {
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
    const dialog = await openHistory("Cola");
    fireEvent.click(await useBtn(dialog, "$9.00"));
    await waitFor(() => expect(total()).toHaveTextContent("$9.00"));
    expect(within(lineOf("Cola")).getByTestId("line-price-chip")).toHaveTextContent(
      "Price changed",
    );
  });
});

describe("W-853 the panel's pack rule, on the counter", () => {
  it("offers a price of the line's own pack and refuses one from a different pack", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await pick("Beta Deli");
    const dialog = await openHistory("Water");
    expect(await useBtn(dialog, "$21.00")).toBeEnabled();
    expect(await useBtn(dialog, "$40.00")).toBeDisabled();
  });
});

describe("W-853 Use this price is a typed price", () => {
  /** Charges the sale and returns the first item sent. */
  const charge = async () => {
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    return mutateAsync.mock.calls[0][0].dto.items[0] as Record<string, unknown>;
  };

  it("writes the line once, exactly as the Change price dialog does for the same number", async () => {
    const first = renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    fireEvent.click(screen.getByRole("button", { name: "Change price for Cola" }));
    await screen.findByRole("dialog", { name: "Change the price for Cola" });
    fireEvent.change(screen.getByRole("textbox", { name: "Price per item" }), {
      target: { value: "9" },
    });
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
    const dialog = await openHistory("Cola");
    fireEvent.click(await useBtn(dialog, "$9.00"));
    await waitFor(() => expect(total()).toHaveTextContent("$9.00"));
    expect(total().textContent).toBe(typedTotal);
    expect(within(lineOf("Cola")).getByTestId("line-price-chip").textContent).toBe(typedChip);
    expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull();
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(1);
    expect(await charge()).toEqual(typedItem);
  });

  it("does not prefill the till: opening the panel changes no price and sends no sale", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    await openHistory("Cola");
    expect(total()).toHaveTextContent("$10.00");
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("a special-tier customer with an off-special history price and no reason: Charge refuses and sends nothing", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Acme Cafe");
    const dialog = await openHistory("Cola");
    fireEvent.click(await useBtn(dialog, "$9.00")); // Acme's price is 8.00
    await waitFor(() => expect(total()).toHaveTextContent("$9.00"));
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a reason for Cola. Acme Cafe has a special price on it.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("a history price within half a cent of the special price asks for no reason and stays a plain line", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Acme Cafe");
    const dialog = await openHistory("Cola");
    fireEvent.click(await useBtn(dialog, "$8.00")); // 8.004 from an old invoice
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull());
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
    expect(total()).toHaveTextContent("$8.00");
    const item = await charge();
    expect(item).not.toHaveProperty("priceReason");
  });

  it("changes nothing while a sale is in flight (the lock holds), and the button is off", async () => {
    mutateAsync.mockReturnValue(new Promise(() => {}));
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    const dialog = await openHistory("Cola");
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(within(lineOf("Cola")).getByRole("button", { name: "Price history" })).toBeDisabled();
    fireEvent.click(await useBtn(dialog, "$9.00"));
    expect(total()).toHaveTextContent("$10.00");
    expect(within(lineOf("Cola")).queryAllByTestId("line-price-chip")).toHaveLength(0);
  });

  it("hands focus back to the scan field after a price is used", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await pick("Beta Deli");
    const dialog = await openHistory("Cola");
    fireEvent.click(await useBtn(dialog, "$9.00"));
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
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
