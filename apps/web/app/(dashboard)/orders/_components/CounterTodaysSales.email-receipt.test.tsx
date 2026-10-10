import * as React from "react";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "@/test-utils/render";
import type { TodaysSaleRow, TodaysSalesResponse } from "@routeflow/types";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * SA-751r on the Today's-sales Reprint view: Email receipt sits right after Print, opens an inline row (not a sheet) inside the
 * sheet, and Escape closes that row before it closes anything else. The API is mocked at the apiClient boundary.
 */
const get = jest.fn();
const post = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { role: "OPERATOR", username: "pat" } }),
}));
let orderCustomer: { businessName: string; email?: string | null } = { businessName: "Walk-in" };
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({
    data: {
      id: "o1",
      orderNumber: "ORD-1",
      customerId: "c1",
      total: 22.5,
      customer: orderCustomer,
      lineItems: [{ id: "l1", name: "Cola", qty: 3, unitPrice: 7.5 }],
    },
  }),
}));

const row = (over: Partial<TodaysSaleRow> = {}): TodaysSaleRow => ({
  orderId: "o1",
  invoiceId: "i1",
  orderNumber: "ORD-1",
  invoiceNumber: "INV-1",
  createdAt: "2026-10-07T15:15:00.000Z",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  customerId: "c1",
  customerName: "Walk-in",
  isWalkIn: true,
  status: "DELIVERED",
  paymentState: "PAID",
  methods: [{ method: "CASH", amount: 22.5 }],
  returned: { amount: 0, state: "NONE", returns: [] },
  voided: false,
  ...over,
});
const serve = (rows: TodaysSaleRow[]) => {
  const resp: TodaysSalesResponse = {
    data: rows,
    meta: {
      total: rows.length,
      page: 1,
      limit: 25,
      totalPages: 1,
      day: "2026-10-07",
      timezone: "America/New_York",
      windowStart: "2026-10-07T04:00:00.000Z",
      windowEnd: "2026-10-08T04:00:00.000Z",
    },
    summary: null,
  };
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/counter-sale/today" ? resp : {} }),
  );
};

const openReprint = async (rows: TodaysSaleRow[] = [row()]) => {
  serve(rows);
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
  await screen.findByTestId("receipt-print-root");
};

beforeEach(() => {
  jest.clearAllMocks();
  orderCustomer = { businessName: "Walk-in" };
  post.mockResolvedValue({ data: { channel: "email", to: "x" } });
});

describe("Today's sales > Reprint > Email receipt (SA-751r)", () => {
  it("the row reads Print · Email receipt · Back to sales, and the email row is not open", async () => {
    await openReprint();
    const dialog = screen.getByRole("dialog");
    const names = within(dialog)
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => ["Print", "Email receipt", "Back to sales"].includes(t ?? ""));
    expect(names).toEqual(["Print", "Email receipt", "Back to sales"]);
    expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
    expect(screen.getByRole("button", { name: "Email receipt" }).className).toContain(
      "min-h-[44px]",
    );
  });

  it("a walk-in sale opens the row empty and focused (the walk-in record's address is never used)", async () => {
    orderCustomer = { businessName: "Walk-in", email: "no-email+1@placeholder.local" };
    await openReprint();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    const input = screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("a named customer's address is the suggestion, Send is focused, and opening sends nothing; Send posts to this order", async () => {
    orderCustomer = { businessName: "Acme Test Customer", email: "buyer@example.com" };
    await openReprint([row({ isWalkIn: false, customerName: "Acme Test Customer" })]);
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    expect((screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement).value).toBe(
      "buyer@example.com",
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent to buyer@example.com.")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/orders/o1/receipt", {
      channel: "email",
      to: "buyer@example.com",
    });
  });

  it("a walk-in typed address is sent as typed and is not written to any customer endpoint", async () => {
    await openReprint();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "someone@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Sent to someone@example.com.");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/orders/o1/receipt");
    expect(get.mock.calls.some((c) => String(c[0]).startsWith("/customers"))).toBe(false);
  });

  it("Escape in the email row closes the row, returns focus to Email receipt, and STAYS on the reprint view", async () => {
    await openReprint();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    const input = screen.getByRole("textbox", { name: "Email address" });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Email receipt" })).toHaveFocus();
    expect(screen.getByTestId("receipt-print-root")).toBeInTheDocument(); // still the reprint
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Escape with the row closed still goes back to the list first (unchanged)", async () => {
    await openReprint();
    fireEvent.keyDown(screen.getByRole("button", { name: "Print" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("receipt-print-root")).toBeNull());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the email controls never print (print:hidden on the button and the row)", async () => {
    await openReprint();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    expect(screen.getByRole("button", { name: "Email receipt" }).className).toContain(
      "print:hidden",
    );
    expect(document.getElementById("email-receipt-row")!.className).toContain("print:hidden");
    expect(screen.getByTestId("receipt-print-root")).not.toContainElement(
      document.getElementById("email-receipt-row"),
    );
  });

  it("a voided sale has no Reprint, so no Email receipt control anywhere in its row", async () => {
    serve([row({ voided: true, status: "CANCELLED" })]);
    renderWithProviders(<CounterTodaysSales />);
    fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
    await screen.findByTestId("today-row-o1");
    expect(screen.queryByRole("button", { name: "Reprint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Email receipt" })).toBeNull();
  });
});
