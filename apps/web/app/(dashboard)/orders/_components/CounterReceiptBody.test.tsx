import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CounterReceiptBody } from "./CounterReceiptBody";

let authUser: { id: string; username: string } | null = { id: "u1", username: "pat" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: authUser }),
}));
let branding: Record<string, unknown> | null = null;
jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({ branding, slug: null, isLoading: false, refresh: jest.fn() }),
}));

const LINES = [
  { tempId: "a", name: "Cola", unitPrice: 2.5, qty: 3 },
  {
    tempId: "b",
    name: "Water",
    unitPrice: 12,
    qty: 15,
    unitsPerBox: 12,
    boxes: 1,
    pieces: 3,
  },
];
const RECEIPT = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  change: 7.5,
  method: "CASH" as const,
  paymentRecorded: true,
};
const PROFILE = {
  businessName: "Settings Name",
  street: "1 Main St",
  city: "Springfield",
  state: "IL",
  zip: "62701",
  phone: "555-0100",
};
const show = (receipt: typeof RECEIPT = RECEIPT, profile: Record<string, unknown> | null = null) =>
  renderWithProviders(
    <CounterReceiptBody
      receipt={receipt}
      lines={LINES}
      enteredTender={null}
      profile={profile as never}
    />,
  );

beforeEach(() => {
  authUser = { id: "u1", username: "pat" };
  branding = null;
});

describe("CounterReceiptBody", () => {
  it("prints each line as qty x unit = total, boxed lines prorated", () => {
    show();
    const cola = screen.getByTestId("receipt-line-a");
    expect(cola).toHaveTextContent("Cola");
    expect(cola).toHaveTextContent("3 × $2.50");
    expect(cola).toHaveTextContent("$7.50");
    const water = screen.getByTestId("receipt-line-b");
    expect(water).toHaveTextContent("1 box + 3 pcs × $12.00 per box");
    expect(water).toHaveTextContent("$15.00");
  });

  it("header: tenant branding name + logo, address and phone from settings", () => {
    branding = { businessName: "Brand Name", logoUrl: "https://cdn.example/logo.png" };
    show(RECEIPT, PROFILE);
    const h = screen.getByTestId("receipt-header");
    expect(h).toHaveTextContent("Brand Name");
    expect(h).not.toHaveTextContent("Settings Name");
    expect(h).toHaveTextContent("1 Main St");
    expect(h).toHaveTextContent("Springfield, IL 62701");
    expect(h).toHaveTextContent("555-0100");
    expect(h.querySelector("img")).toHaveAttribute("src", "https://cdn.example/logo.png");
  });

  it("SA-762r: the named customer, the server's tax and rate and the footer reach the paper; a walk-in has no customer line", () => {
    const profile = { receiptFooter: "Thanks!" };
    const withTax = {
      ...RECEIPT,
      total: 24.75,
      paid: 24.75,
      change: undefined as never,
      tax: 2.25,
      taxRatePercent: 10,
    };
    const { unmount } = renderWithProviders(
      <CounterReceiptBody
        receipt={withTax}
        lines={LINES}
        enteredTender={null}
        profile={profile}
        customerName="Acme Co"
      />,
    );
    expect(screen.getByTestId("receipt-customer")).toHaveTextContent("Customer: Acme Co");
    expect(screen.getByTestId("receipt-tax")).toHaveTextContent("Tax (10%)");
    expect(screen.getByTestId("receipt-tax")).toHaveTextContent("$2.25");
    expect(screen.queryByTestId("receipt-adjustment")).not.toBeInTheDocument();
    expect(screen.getByTestId("receipt-footer")).toHaveTextContent("Thanks!");
    unmount();
    show();
    expect(screen.queryByTestId("receipt-customer")).not.toBeInTheDocument();
  });

  it("exact cash: the server's served change of 0 prints Tendered and a Change $0.00 row (null would print none)", () => {
    const { unmount } = show({ ...RECEIPT, total: 22.5, paid: 22.5, change: 0 });
    expect(screen.getByTestId("receipt-tendered")).toHaveTextContent("$22.50");
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("Change");
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("$0.00");
    unmount();
    show({ ...RECEIPT, total: 22.5, paid: 22.5, change: undefined as never });
    expect(screen.queryByTestId("receipt-change")).not.toBeInTheDocument();
  });

  it("header falls back to the settings name, then to name only, then to nothing", () => {
    const { unmount } = show(RECEIPT, { businessName: "Settings Name" });
    expect(screen.getByTestId("receipt-header")).toHaveTextContent("Settings Name");
    expect(screen.getByTestId("receipt-header")).not.toHaveTextContent("Springfield");
    unmount();
    show(RECEIPT, null);
    expect(screen.queryByTestId("receipt-header")).not.toBeInTheDocument();
  });

  it("shows receipt number, date and time, cashier, method, tendered and change due", () => {
    show();
    expect(screen.getByTestId("receipt-numbers")).toHaveTextContent("Order ORD-1");
    expect(screen.getByTestId("receipt-numbers")).toHaveTextContent("Invoice INV-1");
    expect(screen.getByTestId("receipt-date")).toHaveTextContent(/\d{4}.*\d:\d{2}/);
    expect(screen.getByTestId("receipt-cashier")).toHaveTextContent("Cashier: pat");
    expect(screen.getByTestId("receipt-method")).toHaveTextContent("Cash");
    expect(screen.getByTestId("receipt-tendered")).toHaveTextContent("$30.00");
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("$7.50");
    expect(screen.getByTestId("receipt-total")).toHaveTextContent("$22.50");
    expect(screen.getByTestId("receipt-subtotal")).toHaveTextContent("$22.50");
    expect(screen.queryByTestId("receipt-adjustment")).not.toBeInTheDocument();
  });

  it("the live receipt names the cashier by the shared rule: an email-shaped username prints no Cashier line", () => {
    authUser = { id: "u1", username: "pat@acme.test" };
    show();
    expect(screen.queryByTestId("receipt-cashier")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("pat@acme.test");
  });

  it("a repriced sale adds up: Subtotal + Adjustments = the server total", () => {
    show({ ...RECEIPT, total: 24.75, paid: 24.75, change: undefined as never });
    expect(screen.getByTestId("receipt-subtotal")).toHaveTextContent("$22.50");
    expect(screen.getByTestId("receipt-adjustment")).toHaveTextContent("$2.25");
    expect(screen.getByTestId("receipt-total")).toHaveTextContent("$24.75");
  });

  it("a downward reprice prints the adjustment sign first", () => {
    show({ ...RECEIPT, total: 21.5, paid: 21.5, change: undefined as never });
    expect(screen.getByTestId("receipt-adjustment")).toHaveTextContent("-$1.00");
    expect(screen.getByTestId("receipt-adjustment")).not.toHaveTextContent("$-");
    expect(screen.getByTestId("receipt-total")).toHaveTextContent("$21.50");
  });

  it("card has no change or tendered line", () => {
    show({ ...RECEIPT, method: "CARD" as never, change: undefined as never });
    expect(screen.getByTestId("receipt-method")).toHaveTextContent("Card");
    expect(screen.queryByTestId("receipt-change")).not.toBeInTheDocument();
    expect(screen.queryByTestId("receipt-tendered")).not.toBeInTheDocument();
  });

  it("exact cash shows tendered but no change line", () => {
    show({ ...RECEIPT, change: undefined as never });
    expect(screen.getByTestId("receipt-tendered")).toHaveTextContent("$22.50");
    expect(screen.queryByTestId("receipt-change")).not.toBeInTheDocument();
  });

  it("print: 80 mm paper with 4 mm margins (72 mm printable), root fills it, scoped to this receipt", () => {
    show();
    const root = screen.getByTestId("receipt-print-root");
    expect(root.className).toContain("print:w-full");
    expect(root.className).not.toContain("print:w-[72mm]");
    const css = root.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/@page\s*\{\s*size:\s*80mm auto;\s*margin:\s*4mm;/);
    expect(document.querySelector("header")).toBeNull();
  });
});
