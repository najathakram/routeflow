import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import { createNavShortcutHandler } from "@/lib/nav-shortcuts";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1067 M2b (T1-T6, T8; T7 is a guard: part pay over the total is refused today, so the arm isn't wired there): Enter in Amount tendered or Amount paying now used to complete the sale. A real tender is within one
 * bill ($100) of the total; a tender $100 or more over it needs a second Enter on the SAME figure, so a scanner's code that
 * lands in the field can only arm. The Complete buttons are untouched.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const CASE = { id: "p-case", name: "Case", pricePerUnit: 12.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "CASE" ? { product: CASE, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: {
      data: [
        { id: "c-plain", businessName: "Plain Cafe", pricingTier: 1 },
        { id: "c-walkin", businessName: "Walk-in Record", pricingTier: 1, isWalkIn: true },
      ],
    },
  }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
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
const HINT = "Press Enter again to complete the sale.";
const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 12.5,
  paid: 12.5,
  balanceDue: 0,
  paymentRecorded: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    if (/^\/customers\/[^/]+\/statement$/.test(url))
      return Promise.resolve({
        data: { outstandingAmount: 0, overdueAmount: 0, availableCredit: 0, autoApplyCredit: 0 },
      });
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0, timezone: "UTC" } });
    if (url === "/orders/counter-sale/parked")
      return Promise.resolve({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
    return Promise.resolve({ data: [] });
  });
  mutateAsync.mockResolvedValue(SALE);
});

const scanCase = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "CASE" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Case" });
};
const pickPlain = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "plain" } });
  fireEvent.click(screen.getByRole("option", { name: "Plain Cafe" }));
};
const complete = () =>
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
const posted = () => mutateAsync.mock.calls.length;
const hint = () => screen.queryByText(HINT);

describe("SA-1067 M2b: a tender far over the total needs a second Enter", () => {
  it("T1/T2: cash, total $12.50, tender 4011 Enter does not post, shows the hint and the change; a second Enter posts", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "4011{Enter}");
    expect(posted()).toBe(0);
    expect(hint()).toBeInTheDocument();
    expect(screen.getByTestId("change-due")).toHaveTextContent("Change $3,998.50");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted()).toBe(1));
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({ method: "CASH", amount: 4011 });
  });

  it("T3: 4011 Enter then a second scan 4011 Enter never posts", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    const tender = screen.getByLabelText("Amount tendered");
    await user.type(tender, "4011{Enter}4011{Enter}");
    expect(posted()).toBe(0);
    expect(tender).toHaveValue("40114011");
  });

  it("T4: tender 20 Enter posts on one Enter", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "20{Enter}");
    await waitFor(() => expect(posted()).toBe(1));
    expect(hint()).toBeNull();
  });

  it("T5: 112.49 posts on one Enter (under $100 over); 112.50 arms (exactly $100 over)", async () => {
    const user = userEvent.setup();
    const first = renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "112.49{Enter}");
    await waitFor(() => expect(posted()).toBe(1));
    first.unmount();

    jest.clearAllMocks();
    mutateAsync.mockResolvedValue(SALE);
    renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "112.5{Enter}");
    expect(posted()).toBe(0);
    expect(hint()).toBeInTheDocument();
  });

  it("T6: tender 4011 and a click on Complete posts at once", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "4011");
    complete();
    await waitFor(() => expect(posted()).toBe(1));
  });

  it("T7 (guard): part pay (card) over the total is refused at once by Enter: no post, no arm", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    await user.type(screen.getByLabelText("Amount paying now"), "4011{Enter}");
    expect(posted()).toBe(0);
    expect(hint()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/can't be more than the total/);
  });

  it("T8: part pay under the balance, Enter posts on one Enter as today", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    await user.type(screen.getByLabelText("Amount paying now"), "5{Enter}");
    await waitFor(() => expect(posted()).toBe(1));
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({ method: "CARD", amount: 5 });
  });
});

describe("SA-1067 A-2: an arm lasts only while the value stands", () => {
  it("T9: cash, 4011 Enter, clear Amount tendered, 4011 Enter again: no post, the hint is back", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    const tender = screen.getByLabelText("Amount tendered");
    await user.type(tender, "4011{Enter}");
    expect(hint()).toBeInTheDocument();
    await user.clear(tender);
    expect(hint()).toBeNull();
    await user.type(tender, "4011{Enter}");
    expect(posted()).toBe(0);
    expect(hint()).toBeInTheDocument();
  });

  it("T10: an arm does not outlive its sale: 4011 Enter, type 20 over it, Complete; the next sale at the same total needs two Enters for 4011", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    const tender = screen.getByLabelText("Amount tendered");
    await user.type(tender, "4011{Enter}");
    await user.clear(tender);
    await user.type(tender, "20");
    complete();
    await waitFor(() => expect(posted()).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: "New sale" }));
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "4011{Enter}");
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(posted()).toBe(1);
  });

  it("T11: 4011 Enter, change the quantity and put it back, Enter: no post, the hint is back", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    await scanCase();
    await user.type(screen.getByLabelText("Amount tendered"), "4011{Enter}");
    const qty = screen.getByLabelText("Set quantity of Case");
    for (const n of ["2", "1"]) {
      fireEvent.change(qty, { target: { value: n } });
      fireEvent.keyDown(qty, { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("change-due")).toBeInTheDocument());
    }
    screen.getByLabelText("Amount tendered").focus();
    await user.keyboard("{Enter}");
    expect(posted()).toBe(0);
    expect(hint()).toBeInTheDocument();
  });
});

describe("SA-1067 M4: a capital letter at a desktop till goes to the scan box", () => {
  const scanField = () => screen.getByLabelText("Scan or search items");
  const withButtonFocused = async () => {
    renderTill(<CounterSaleScreen />);
    await scanCase();
    const btn = screen.getByRole("button", { name: "Remove Case" });
    btn.focus();
    return btn;
  };

  it("a capital A typed while a button holds focus moves focus to the scan box", async () => {
    const btn = await withButtonFocused();
    fireEvent.keyDown(btn, { key: "A" });
    expect(scanField()).toHaveFocus();
  });

  it.each(["g", "a", "?"])(
    "a lowercase %s is left alone (the g-then-x shortcuts stay)",
    async (key) => {
      const btn = await withButtonFocused();
      fireEvent.keyDown(btn, { key });
      expect(scanField()).not.toHaveFocus();
    },
  );

  it("L1: focus on a line button, the whole wedge code AB12345 reaches the scan box, and its Enter submits all of it", async () => {
    const user = userEvent.setup();
    const btn = await withButtonFocused();
    expect(btn).toHaveFocus();
    await user.keyboard("AB12345");
    expect(scanField()).toHaveValue("AB12345"); // the letters are not lost, so 12345 alone is never what is submitted
    expect(scanField()).toHaveFocus();
  });

  it("L1b: a capitals code that is a real item, typed from a button, is found and added by its Enter", async () => {
    const user = userEvent.setup();
    const btn = await withButtonFocused();
    expect(btn).toHaveFocus();
    await user.keyboard("CASE{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Set quantity of Case")).toHaveValue(2));
  });

  it("L4: Caps Lock on, G then H on a plain button goes to the scan box and does not navigate", async () => {
    const push = jest.fn();
    const handler = createNavShortcutHandler({
      push,
      routesAccess: true,
      counterEnabled: true,
      toggleHelp: jest.fn(),
    });
    window.addEventListener("keydown", handler); // the dashboard shell's own listener
    try {
      const btn = await withButtonFocused();
      fireEvent.keyDown(btn, { key: "G" });
      expect(scanField()).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: "H" });
      expect(push).not.toHaveBeenCalled();
      expect(scanField()).toHaveFocus();
    } finally {
      window.removeEventListener("keydown", handler);
    }
  });

  it("a digit still goes to the scan box", async () => {
    const btn = await withButtonFocused();
    fireEvent.keyDown(btn, { key: "5" });
    expect(scanField()).toHaveFocus();
  });
});
