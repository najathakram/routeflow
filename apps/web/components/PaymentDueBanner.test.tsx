import * as React from "react";
import userEvent from "@testing-library/user-event";
import type { PaymentDueView } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { PaymentDueBanner } from "./PaymentDueBanner";

const mockPay = jest.fn();
const mockPortal = jest.fn();
jest.mock("@/lib/api/payment-due", () => ({
  usePayPaymentDue: () => ({ mutate: mockPay, isPending: false }),
}));
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: mockPortal, isPending: false }),
}));
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));
jest.mock("@/lib/counter-cart-signal", () => ({ guardCounterLeave: () => false }));

const due = (over: Partial<PaymentDueView> = {}): PaymentDueView => ({
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe("PaymentDueBanner", () => {
  it("past due, admin: copy, Pay now starts the checkout, View billing links to billing", async () => {
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="admin" />);
    const box = screen.getByTestId("payment-due-banner");
    expect(box).toHaveAttribute("data-state", "past-due");
    expect(within(box).getByText("Your payment is past due.")).toBeInTheDocument();
    expect(
      within(box).getByText(
        "Pay $100.00 for your October 2026 subscription to keep using RouteFlow.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(box).getByRole("button", { name: "Pay now" }));
    expect(mockPay).toHaveBeenCalledTimes(1);
    expect(within(box).getByRole("link", { name: "View billing" })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    expect(within(box).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(box.className).not.toMatch(/red/);
  });

  it("due (not past due), admin: the softer title", () => {
    renderWithProviders(
      <PaymentDueBanner mode="payment-due" due={due({ pastDue: false })} role="admin" />,
    );
    expect(screen.getByText("Your payment is due.")).toBeInTheDocument();
    expect(screen.getByTestId("payment-due-banner")).toHaveAttribute("data-state", "due");
  });

  it("operator: no Pay now in the DOM, asks the account admin, still has View billing", () => {
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="staff" />);
    const box = screen.getByTestId("payment-due-banner");
    expect(within(box).queryByRole("button", { name: /pay/i })).toBeNull();
    expect(within(box).getByText("Ask your account admin to pay.")).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: "View billing" })).toBeInTheDocument();
  });

  it("View billing goes through the router (no full reload)", async () => {
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="admin" />);
    await userEvent.click(screen.getByRole("link", { name: "View billing" }));
    expect(mockPush).toHaveBeenCalledWith("/settings/billing");
  });

  it("hideBillingLink: no link to the page already open", () => {
    renderWithProviders(
      <PaymentDueBanner mode="payment-due" due={due()} role="admin" hideBillingLink />,
    );
    expect(screen.queryByRole("link", { name: "View billing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
  });

  it("failed renewal, admin: Update card opens the billing portal", async () => {
    renderWithProviders(<PaymentDueBanner mode="failed-renewal" role="admin" />);
    const box = screen.getByTestId("payment-due-banner");
    expect(box).toHaveAttribute("data-state", "failed-renewal");
    expect(within(box).getByText("Your last payment didn't go through.")).toBeInTheDocument();
    expect(within(box).getByText("Update your card to keep using RouteFlow.")).toBeInTheDocument();
    await userEvent.click(within(box).getByRole("button", { name: "Update card" }));
    expect(mockPortal).toHaveBeenCalledWith({ intent: "update-payment" });
    expect(mockPay).not.toHaveBeenCalled();
  });

  it("failed renewal, operator: no Update card, asks the admin", () => {
    renderWithProviders(<PaymentDueBanner mode="failed-renewal" role="staff" />);
    expect(screen.queryByRole("button", { name: "Update card" })).toBeNull();
    expect(screen.getByText("Ask your account admin to update the card.")).toBeInTheDocument();
  });

  it("operator can dismiss a payment due for the day, and it stays gone", async () => {
    const { unmount } = renderWithProviders(
      <PaymentDueBanner mode="payment-due" due={due()} role="staff" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
    unmount();
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="staff" />);
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("admin has no dismiss control on a payment due", () => {
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="admin" />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("failed renewal keeps the strip's dismiss rule", async () => {
    renderWithProviders(
      <PaymentDueBanner
        mode="failed-renewal"
        role="admin"
        dismiss={{ scope: "day", key: "grace:in_1:2026-10-15" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("not due: renders nothing", () => {
    const { container } = renderWithProviders(
      <PaymentDueBanner mode="payment-due" due={due({ due: false })} role="admin" />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("no em or en dash is rendered", () => {
    const { container } = renderWithProviders(
      <PaymentDueBanner mode="payment-due" due={due()} role="staff" />,
    );
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  it("controls are >= 44 px hit areas and the row wraps at 390", () => {
    renderWithProviders(<PaymentDueBanner mode="payment-due" due={due()} role="admin" />);
    expect(screen.getByRole("button", { name: "Pay now" }).className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByRole("link", { name: "View billing" }).className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByTestId("payment-due-banner").className).toMatch(/flex-wrap/);
  });
});
