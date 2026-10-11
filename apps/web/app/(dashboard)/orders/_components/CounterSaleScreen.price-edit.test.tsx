import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { cartTotals } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * POS-5 / SA-762r: price edit at the counter. ONE gate (`staffMay(role, "EDIT_LINE_PRICE")`: OPERATOR and TENANT_ADMIN): a
 * SUPER_ADMIN (until perms PR7), a driver, a missing user or an unknown
 * role never gets the control (hidden, not disabled). An admin's edit resolves to ONE net unit price through
 * @routeflow/pricing; the line, totals, payload and receipt all follow it; a customer pick keeps it (the survive rule).
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME] } }),
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
let taxRatePercent = 0;

const ADMIN = { id: "u-a", tenantSlug: "acme", role: "TENANT_ADMIN" };
const OPERATOR = { id: "u-o", tenantSlug: "acme", role: "OPERATOR" };

const saleResponse = (total: number) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total,
  paid: total,
  balanceDue: 0,
  change: 0,
  paymentRecorded: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockUser = ADMIN;
  taxRatePercent = 0;
  get.mockImplementation((url: string) =>
    url.startsWith("/customers/")
      ? Promise.resolve({ data: [] })
      : Promise.resolve({ data: { taxRate: taxRatePercent } }),
  );
  mutateAsync.mockResolvedValue(saleResponse(9));
});

const NAME: Record<string, string> = { COLA: "Cola", JUICE: "Juice", WATER: "Water" };
/** Scans a code and waits until its line is on the cart (the field clears at once; the line lands after the lookup). */
const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `Remove ${NAME[text]}` })).toBeInTheDocument(),
  );
};
const total = () => screen.getByTestId("running-total");
const pickAcme = async () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Acme Cafe" }));
  await waitFor(() => expect(screen.queryByTestId("counter-reprice-busy")).toBeNull());
};
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });
const nextBtn = () => screen.getByRole("button", { name: "Complete & next sale" });
const editBtn = (name: string) => screen.getByRole("button", { name: `Edit price for ${name}` });
const lineOf = (name: string) =>
  screen.getByRole("button", { name: `Remove ${name}` }).closest("li") as HTMLElement;

/** Opens the dialog for `name`, picks a mode, types the number (and a reason) and presses Apply. */
async function editPrice(
  name: string,
  o: { mode?: "Percent off" | "Amount off"; label: string; value: string; reason?: string },
) {
  fireEvent.click(editBtn(name));
  await screen.findByRole("dialog", { name: `Change price for ${name}` });
  if (o.mode) fireEvent.click(screen.getByRole("radio", { name: o.mode }));
  fireEvent.change(screen.getByRole("textbox", { name: o.label }), { target: { value: o.value } });
  if (o.reason !== undefined) {
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), {
      target: { value: o.reason },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
const tenPercentOffCola = (reason?: string) =>
  editPrice("Cola", { mode: "Percent off", label: "Percent off", value: "10", reason });
const sentItems = (call = 0) =>
  mutateAsync.mock.calls[call][0].dto.items as Record<string, unknown>[];

describe("POS-5 price edit: hidden without the grant (the ONE gate)", () => {
  it.each([
    ["a SUPER_ADMIN", { ...ADMIN, role: "SUPER_ADMIN" }],
    ["a DRIVER", { ...ADMIN, role: "DRIVER" }],
    ["a signed-in user with no role", { id: "u-x", tenantSlug: "acme" }],
    ["no user at all", undefined],
    ["a null user", null],
  ] as [string, MockUser][])(
    "%s never sees the control, its label, its dialog or its tab stop",
    async (_who, user) => {
      mockUser = user;
      const { container } = renderWithProviders(<CounterSaleScreen />);
      await scan("COLA");
      await waitFor(() => expect(total()).toHaveTextContent("$10.00"));
      expect(screen.queryByRole("button", { name: /Edit price/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Reset price/ })).toBeNull();
      expect(container.innerHTML).not.toMatch(/Edit price|Reset price/);
      expect(lineOf("Cola").querySelectorAll("button, input").length).toBe(
        // remove, 2 steppers, the typed qty field, Add note: nothing new
        5,
      );
    },
  );

  it("an OPERATOR and a TENANT_ADMIN get the button", async () => {
    mockUser = OPERATOR;
    const first = renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    expect(editBtn("Cola")).toBeEnabled();
    first.unmount();
    mockUser = ADMIN;
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    expect(editBtn("Cola")).toBeEnabled();
  });

  it("a sale rung by a user without the control carries no price on any line", async () => {
    mockUser = { ...ADMIN, role: "DRIVER" };
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(Object.keys(sentItems()[0]).sort()).toEqual(["productId", "qty"]);
  });
});

describe("POS-5 price edit: the cart and totals", () => {
  it("10% off a 10.00 line: struck original, net, chip, a Discounts row, and the total follows", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    const li = lineOf("Cola");
    expect(within(li).getByTestId("line-original-total")).toHaveTextContent("$10.00");
    expect(within(li).getByTestId("line-net-total")).toHaveTextContent("$9.00");
    expect(within(li).getByTestId("line-price-chip")).toHaveTextContent("10% off");
    expect(screen.getByTestId("running-discounts")).toHaveTextContent("Discounts-$1.00");
    expect(total()).toHaveTextContent("$9.00");
    // the estimate IS cartTotals of the edited cart
    expect(cartTotals([{ unitPrice: 9, qty: 1 }], 0).total).toBe(9);
  });

  it("Reset price restores the plain line and removes the Discounts row", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    fireEvent.click(screen.getByRole("button", { name: "Reset price" }));
    expect(screen.queryByTestId("running-discounts")).toBeNull();
    expect(screen.queryByTestId("line-price-chip")).toBeNull();
    expect(screen.queryByTestId("line-original-total")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset price" })).toBeNull();
    expect(total()).toHaveTextContent("$10.00");
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });

  it("amount off reads '$2.00 off each'; a set price reads 'Price changed'; a raised price adds no discount", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await editPrice("Cola", { mode: "Amount off", label: "Amount off per item", value: "2" });
    expect(within(lineOf("Cola")).getByTestId("line-price-chip")).toHaveTextContent(
      "$2.00 off each",
    );
    expect(total()).toHaveTextContent("$8.00");
    await editPrice("Cola", { label: "Price per item", value: "12" });
    expect(within(lineOf("Cola")).getByTestId("line-price-chip")).toHaveTextContent(
      "Price changed",
    );
    expect(screen.queryByTestId("running-discounts")).toBeNull();
    expect(total()).toHaveTextContent("$12.00");
  });

  it("a second edit replaces the first (never stacks), and a stepper keeps the per-unit price", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    await tenPercentOffCola(); // 10% of the TIER price again, not of 9.00
    expect(total()).toHaveTextContent("$9.00");
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" }));
    await waitFor(() => expect(total()).toHaveTextContent("$18.00")); // 2 x 9.00
    expect(screen.getByTestId("running-discounts")).toHaveTextContent("-$2.00");
  });

  it("a repeat scan keeps the edited price; removing the line drops it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    await scan("COLA");
    await waitFor(() => expect(total()).toHaveTextContent("$18.00"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Cola" }));
    expect(screen.queryByTestId("running-discounts")).toBeNull();
    await scan("COLA");
    expect(total()).toHaveTextContent("$10.00"); // a fresh line is a plain line
  });

  it("a boxed line (1 box + 3 pcs): 10% off is a 21.60 BOX price and the total is computeLineSubtotal, never qty x price", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("WATER");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Add a piece to Water" }));
    }
    await waitFor(() => expect(total()).toHaveTextContent("$30.00")); // 24 + 3 x (24/12)
    fireEvent.click(editBtn("Water"));
    await screen.findByRole("dialog", { name: "Change price for Water" });
    fireEvent.click(screen.getByRole("radio", { name: "Percent off" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Percent off" }), {
      target: { value: "10" },
    });
    expect(screen.getByText("New price $21.60 per box. Line total $27.00.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total()).toHaveTextContent("$27.00"); // 21.60 + 3 x 1.80, not 15 x 21.60
    expect(within(lineOf("Water")).getByTestId("line-original-total")).toHaveTextContent("$30.00");
    expect(screen.getByTestId("running-discounts")).toHaveTextContent("-$3.00");
  });
});

describe("POS-5 price edit: the dialog on the screen", () => {
  it("opens with focus in the number field; Escape and Cancel change nothing and focus returns to the scan field", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(editBtn("Cola"));
    const dialog = await screen.findByRole("dialog", { name: "Change price for Cola" });
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: "Price per item" })).toHaveFocus(),
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Price per item" }), {
      target: { value: "1" },
    });
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    expect(total()).toHaveTextContent("$10.00");
    fireEvent.click(editBtn("Cola"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    expect(total()).toHaveTextContent("$10.00");
    expect(screen.queryByTestId("line-price-chip")).toBeNull();
    expect(mutateAsync).not.toHaveBeenCalled(); // the dialog never fires a request
  });

  it("Enter applies; a refusal shows its exact copy in role=alert and the dialog stays open", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(editBtn("Cola"));
    await screen.findByRole("dialog");
    const field = screen.getByRole("textbox", { name: "Price per item" });
    fireEvent.change(field, { target: { value: "-1" } });
    fireEvent.submit(field);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter 0 or more.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(total()).toHaveTextContent("$10.00");
    fireEvent.change(field, { target: { value: "7.5" } });
    fireEvent.submit(field);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total()).toHaveTextContent("$7.50");
  });

  it("the control is disabled while the outcome of a sale is unknown", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    mutateAsync.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await screen.findByTestId("counter-outcome-unknown");
    expect(editBtn("Cola")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset price" })).toBeDisabled();
  });
});

describe("POS-5 price edit: the request", () => {
  it("only the edited line carries unitPrice (the rounded net) and priceReason; the other line is untouched", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("JUICE");
    await tenPercentOffCola("Damaged box");
    await waitFor(() => expect(total()).toHaveTextContent("$14.00"));
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentItems()).toEqual([
      { productId: "p-cola", qty: 1, unitPrice: 9, priceReason: "Damaged box" },
      { productId: "p-juice", qty: 1 },
    ]);
    expect(Object.keys(sentItems()[1]).sort()).toEqual(["productId", "qty"]);
  });

  it("a blank reason sends no priceReason key", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola("   ");
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentItems()[0]).toEqual({ productId: "p-cola", qty: 1, unitPrice: 9 });
    expect("priceReason" in sentItems()[0]).toBe(false);
  });

  it("a boxed edited line sends the BOX net price with its box split", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("WATER");
    await editPrice("Water", { mode: "Percent off", label: "Percent off", value: "10" });
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentItems()[0]).toMatchObject({
      productId: "p-water",
      boxes: 1,
      pieces: 0,
      qty: 12,
      unitPrice: 21.6,
    });
  });

  it("an attempt holding an edited line is retried with the SAME key and body", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola("Damaged box");
    mutateAsync.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await screen.findByTestId("counter-outcome-unknown");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0]).toEqual(mutateAsync.mock.calls[0][0]);
    expect(mutateAsync.mock.calls[1][0].dto.items[0].unitPrice).toBe(9);
  });

  it("the server's 403 PRICE_EDIT_NOT_PERMITTED shows its own copy, keeps the cart and edits, and drops the key", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    mutateAsync.mockRejectedValueOnce({
      response: { status: 403, data: { code: "PRICE_EDIT_NOT_PERMITTED" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "You can't change prices. Use Reset price on the edited lines, or ask your account admin.",
    );
    expect(alert.textContent).not.toMatch(/permission to complete/);
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(total()).toHaveTextContent("$9.00"); // cart and override intact
    expect(screen.getByTestId("line-price-chip")).toHaveTextContent("10% off");
    expect(screen.getByRole("button", { name: "Reset price" })).toBeEnabled();
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0].idempotencyKey).not.toBe(
      mutateAsync.mock.calls[0][0].idempotencyKey,
    );
  });
});

describe("POS-5 price edit: a special-price customer needs a reason", () => {
  it("tier 1 (walk-in), blank reason: allowed", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola();
    expect(screen.getByTestId("line-price-chip")).toBeInTheDocument();
  });

  it("tier 2 customer + a real change + blank reason: the dialog refuses with the reason copy; with a reason it applies and is sent", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await pickAcme();
    await scan("COLA"); // 8.00 at tier 2
    await waitFor(() => expect(total()).toHaveTextContent("$8.00"));
    fireEvent.click(editBtn("Cola"));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox", { name: "Price per item" }), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a reason. Acme Cafe has a special price on this item.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), {
      target: { value: "Damaged box" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(total()).toHaveTextContent("$6.00");
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentItems()[0]).toMatchObject({ unitPrice: 6, priceReason: "Damaged box" });
  });
});

describe("POS-5 price edit: the estimate matches the server, so 'next sale' resets", () => {
  it("a discounted boxed line with 8.25% tax: Complete & next sale starts a fresh sale, not the receipt", async () => {
    taxRatePercent = 8.25;
    const serverTotal = cartTotals(
      [{ unitPrice: 21.6, qty: 15, boxes: 1, pieces: 3, unitsPerBox: 12 }],
      0.0825,
    ).total;
    mutateAsync.mockResolvedValue(saleResponse(serverTotal));
    renderWithProviders(<CounterSaleScreen />);
    await scan("WATER");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Add a piece to Water" }));
    }
    await editPrice("Water", { mode: "Percent off", label: "Percent off", value: "10" });
    await waitFor(() => expect(total()).toHaveTextContent(`$${serverTotal.toFixed(2)}`));
    expect(serverTotal).toBe(29.23); // 27.00 + 2.23 tax
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(nextBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
    expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
  });
});

describe("POS-5 price edit: the receipt", () => {
  it("shows the struck original, the net and the discount for the edited line only, and a Discounts row", async () => {
    // the server serves the stored lines: Cola was rung at 9.00 off its 10.00 LIST price (the struck base is the list, not the cart's tier)
    mutateAsync.mockResolvedValue({
      ...saleResponse(14),
      lines: [
        { productId: "p-cola", unitPrice: 9, originalPrice: 10, priceType: "DISCOUNTED" },
        { productId: "p-juice", unitPrice: 5, originalPrice: null, priceType: "STANDARD" },
      ],
    });
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("JUICE");
    await tenPercentOffCola();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    const cola = await screen.findByTestId("receipt-line-p-cola-0");
    expect(within(cola).getByTestId("receipt-line-original")).toHaveTextContent("$10.00");
    expect(within(cola).getByTestId("receipt-line-net")).toHaveTextContent("$9.00");
    expect(within(cola).getByTestId("receipt-line-discount")).toHaveTextContent("Discount -$1.00");
    const juice = screen.getByTestId("receipt-line-p-juice-1");
    expect(within(juice).queryByTestId("receipt-line-original")).toBeNull();
    expect(within(juice).queryByTestId("receipt-line-discount")).toBeNull();
    expect(screen.getByTestId("receipt-discounts")).toHaveTextContent("Discounts-$1.00");
  });

  it("a sale with no edits has no struck figure, no discount line and no Discounts row", async () => {
    mutateAsync.mockResolvedValue(saleResponse(15));
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("JUICE");
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    await screen.findByTestId("counter-sale-receipt");
    const receipt = screen.getByTestId("counter-sale-receipt");
    expect(within(receipt).queryByTestId("receipt-line-original")).toBeNull();
    expect(within(receipt).queryByTestId("receipt-line-discount")).toBeNull();
    expect(within(receipt).queryByTestId("receipt-discounts")).toBeNull();
    expect(receipt.textContent).not.toMatch(/Discount|Price changed/);
  });
});

describe("POS-5 price edit: a customer pick keeps the edited price (POS-2 survive rule)", () => {
  it("50% off at tier 1 is kept as the net at tier 2: the 'was' figure, the chip and the note follow", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("JUICE");
    await editPrice("Cola", { mode: "Percent off", label: "Percent off", value: "50" });
    await waitFor(() => expect(total()).toHaveTextContent("$10.00")); // 5.00 + 5.00
    await pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$9.00")); // cola kept 5.00, juice re-priced to 4.00
    const li = lineOf("Cola");
    // row 322d: the struck figure is the LIST total (10.00), the receipt's reference, not the customer's tier total (8.00)
    expect(within(li).getByTestId("line-original-total")).toHaveTextContent("$10.00");
    expect(within(li).getByTestId("line-net-total")).toHaveTextContent("$5.00");
    expect(within(li).getByTestId("line-price-chip")).toHaveTextContent("37.5% off");
    expect(within(lineOf("Juice")).queryByTestId("line-price-chip")).toBeNull();
    expect(screen.getByTestId("counter-reprice-note")).toHaveTextContent(
      "Prices updated for Acme Cafe (Tier 2). 1 edited price kept.",
    );
  });

  it("with no edits the note is exactly POS-2's (no edited-price sentence)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$8.00"));
    expect(screen.getByTestId("counter-reprice-note").textContent).toMatch(
      /^Prices updated for Acme Cafe \(Tier 2\)\.\s*UndoDismiss$/,
    );
  });

  it("a kept net equal to the new tier price is no override: the chip and the Discounts row go", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await editPrice("Cola", { label: "Price per item", value: "8" });
    expect(screen.getByTestId("running-discounts")).toHaveTextContent("-$2.00");
    await pickAcme();
    await waitFor(() => expect(screen.queryByTestId("line-price-chip")).toBeNull());
    expect(screen.queryByTestId("running-discounts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset price" })).toBeNull();
    expect(total()).toHaveTextContent("$8.00");
  });

  it("a kept net above the new tier price reads 'Price changed'", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await editPrice("Cola", { mode: "Percent off", label: "Percent off", value: "10" }); // 9.00
    await pickAcme(); // tier 2 price is 8.00: 9.00 is now ABOVE it
    await waitFor(() =>
      expect(within(lineOf("Cola")).getByTestId("line-price-chip")).toHaveTextContent(
        "Price changed",
      ),
    );
    // row 322d: Discounts is measured from the LIST price (10.00) like the receipt: 9.00 is still 1.00 off it
    expect(screen.getByTestId("running-discounts")).toHaveTextContent("-$1.00");
    expect(total()).toHaveTextContent("$9.00");
  });

  it("a special-tier pick over a kept override with no reason refuses Complete with the reason copy and no POST", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await tenPercentOffCola(); // tier 1, no reason: fine
    await pickAcme();
    await waitFor(() => expect(screen.getByTestId("counter-reprice-note")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(completeBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a reason for Cola. Acme Cafe has a special price on it.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    // giving the line a reason clears the refusal
    await editPrice("Cola", {
      mode: "Percent off",
      label: "Percent off",
      value: "10",
      reason: "Damaged box",
    });
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentItems()[0]).toMatchObject({ priceReason: "Damaged box" });
  });
});
