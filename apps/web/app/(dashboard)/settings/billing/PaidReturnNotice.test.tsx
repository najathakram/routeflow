import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PaidReturnNotice } from "./PaidReturnNotice";

let mockQuery = "";
let mockSub: Record<string, unknown> | undefined;
jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({ data: mockSub }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

describe("PaidReturnNotice", () => {
  beforeEach(() => {
    mockSub = undefined;
  });

  it("a bank debit still processing reads as processing, never received (B1256)", () => {
    mockQuery = "paid=1";
    mockSub = { billingState: "processing", paymentProcessing: true };
    renderWithProviders(<PaidReturnNotice />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Your payment is processing. Your bank hasn't cleared it yet.");
    expect(note).not.toHaveTextContent("received");
  });

  it("a settled account (nothing owed) says Payment received", () => {
    mockQuery = "paid=1";
    mockSub = { billingState: "current" };
    renderWithProviders(<PaidReturnNotice />);
    expect(screen.getByRole("status")).toHaveTextContent("Payment received.");
  });

  it("a failed payment uses the existing fixed failure copy", () => {
    mockQuery = "paid=1";
    mockSub = { billingState: "overdue", pastDueInvoiceId: "in_1" };
    renderWithProviders(<PaidReturnNotice />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Your last payment didn't go through.");
    expect(note).not.toHaveTextContent("received");
  });

  it("loading or unknown state is neutral: no claim either way", () => {
    mockQuery = "paid=1";
    for (const sub of [undefined, {}, { billingState: "due" }]) {
      mockSub = sub;
      const { unmount } = renderWithProviders(<PaidReturnNotice />);
      const note = screen.getByRole("status");
      expect(note).toHaveTextContent("Checking your payment. This can take a few minutes.");
      expect(note).not.toHaveTextContent("received");
      unmount();
    }
  });

  it("?paid=1&card=1 (a card add, nothing charged) never says 'Payment received'", () => {
    mockQuery = "paid=1&card=1";
    mockSub = { billingState: "current" };
    renderWithProviders(<PaidReturnNotice />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Card added. It can take a few minutes to confirm.");
    expect(note).not.toHaveTextContent("Payment received");
  });

  it("can be dismissed", async () => {
    mockQuery = "paid=1";
    mockSub = { billingState: "current" };
    renderWithProviders(<PaidReturnNotice />);
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("no param, or any other value: nothing", () => {
    for (const q of ["", "paid=0", "checkout=cancelled"]) {
      mockQuery = q;
      const { container, unmount } = renderWithProviders(<PaidReturnNotice />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
