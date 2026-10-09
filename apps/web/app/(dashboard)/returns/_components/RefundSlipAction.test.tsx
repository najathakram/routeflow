import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { RefundSlipAction } from "./RefundSlipAction";

/**
 * Train 4: "Print slip" on the Return page and after a refund confirms. The slip prints from a body portal (so the page
 * behind never prints) while `body.refund-slip-open` hides everything else; it is built from GET /returns/:id.
 */
let mockReturn: unknown = undefined;
jest.mock("@/lib/api/returns", () => ({
  ...jest.requireActual("@/lib/api/returns"),
  useReturn: () => ({ data: mockReturn, isLoading: mockReturn === undefined }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({
      data: { businessName: "Acme Foods", timezone: "UTC", receiptFooter: "Thanks for shopping!" },
    }),
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u1", username: "pat" } }),
}));
jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({ branding: { logoUrl: null, businessName: "Acme Foods" } }),
}));

const REFUNDED = {
  id: "r1",
  returnNumber: "RET-7",
  kind: "INLINE",
  status: "REFUNDED",
  order: { id: "o1", orderNumber: "ORD-1", counterSale: true },
  items: [{ id: "i1", product: { id: "p1", name: "Cola" }, qty: 2, unitPrice: 2.5 }],
  refundAmount: 5,
  refundMethod: "EXTERNAL_REFUND",
  refundTender: "CARD",
  refundedAt: "2026-10-09T14:00:00Z",
  createdAt: "2026-10-09T13:00:00Z",
};

const print = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockReturn = REFUNDED;
  window.print = print;
});

describe("RefundSlipAction", () => {
  it("shows a Print slip button for a refunded return", async () => {
    renderWithProviders(<RefundSlipAction returnId="r1" />);
    expect(await screen.findByRole("button", { name: "Print slip" })).toBeEnabled();
  });

  it("shows nothing for a return that has not been refunded yet", () => {
    mockReturn = {
      ...REFUNDED,
      status: "RECEIVED",
      refundAmount: null,
      refundMethod: null,
      refundTender: null,
    };
    renderWithProviders(<RefundSlipAction returnId="r1" />);
    expect(screen.queryByRole("button", { name: "Print slip" })).toBeNull();
  });

  it("is disabled while the return is still loading", () => {
    mockReturn = undefined;
    renderWithProviders(<RefundSlipAction returnId="r1" />);
    expect(screen.getByRole("button", { name: "Print slip" })).toBeDisabled();
  });

  it("clicking prints the slip from a body portal and clears the print scope afterwards", async () => {
    renderWithProviders(<RefundSlipAction returnId="r1" />);
    const btn = await screen.findByRole("button", { name: "Print slip" });
    let during: { portal: boolean; bodyClass: boolean; text: string } | null = null;
    print.mockImplementation(() => {
      const portal = document.querySelector("[data-refund-slip-portal]");
      during = {
        portal: !!portal && portal.parentElement === document.body,
        bodyClass: document.body.classList.contains("refund-slip-open"),
        text: portal?.textContent ?? "",
      };
    });
    fireEvent.click(btn);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(during).not.toBeNull();
    expect(during!.portal).toBe(true);
    expect(during!.bodyClass).toBe(true);
    for (const want of [
      "Acme Foods",
      "RET-7",
      "Counter sale ORD-1",
      "Cola",
      "Refunded to Card",
      "$5.00",
      "Cashier: pat",
      "Thanks for shopping!",
    ]) {
      expect(during!.text).toContain(want);
    }
    await waitFor(() => expect(document.body.classList.contains("refund-slip-open")).toBe(false));
    expect(document.querySelector("[data-refund-slip-portal]")).toBeNull();
  });

  it("autoPrint prints once when the refunded return arrives, and not again on re-render", async () => {
    const view = renderWithProviders(<RefundSlipAction returnId="r1" autoPrint />);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    view.rerender(<RefundSlipAction returnId="r1" autoPrint />);
    await new Promise((r) => setTimeout(r, 30));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("without autoPrint nothing prints until the button is pressed", async () => {
    renderWithProviders(<RefundSlipAction returnId="r1" />);
    await screen.findByRole("button", { name: "Print slip" });
    await new Promise((r) => setTimeout(r, 30));
    expect(print).not.toHaveBeenCalled();
  });

  it("the on-screen tree holds no slip text (only the print portal carries it)", async () => {
    const { container } = renderWithProviders(<RefundSlipAction returnId="r1" />);
    await screen.findByRole("button", { name: "Print slip" });
    expect(within(container).queryByText("RET-7")).toBeNull();
  });
});
