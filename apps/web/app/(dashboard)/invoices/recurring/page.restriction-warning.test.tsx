import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, act } from "@/test-utils/render";
import RecurringInvoicesPage from "./page";

/**
 * Row 510, ruling Q2: a MANUAL "Run Now" is judged for the person who clicks it, so a 409 RESTRICTION_WARNING opens
 * the warning dialog (a reason per line, by that user); the scheduled run is unattended and never reaches a dialog.
 */
const runMutate = jest.fn();
const toast = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useRecurringInvoices: () => ({
    isLoading: false,
    data: [
      {
        id: "ri-1",
        name: "Monthly supplies",
        isActive: true,
        frequency: "MONTHLY",
        dayOfMonth: 1,
        nextRunAt: "2026-11-01T00:00:00.000Z",
        customer: { businessName: "Acme Foods" },
        items: [],
      },
    ],
  }),
  useDeactivateRecurringInvoice: () => ({ mutate: jest.fn() }),
  useActivateRecurringInvoice: () => ({ mutate: jest.fn() }),
  useRunRecurringInvoice: () => ({ mutate: runMutate, isPending: false }),
}));

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
          productId: "p1",
          displayName: "Widget",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    },
  },
};

describe("Recurring invoices: row 510 manual Run Now", () => {
  beforeEach(() => jest.clearAllMocks());

  it("warns the clicker, then re-runs the same template with the ack", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoicesPage />);
    await user.click(await screen.findByRole("button", { name: /run now/i }));
    expect(runMutate.mock.calls[0][0]).toBe("ri-1");
    act(() => runMutate.mock.calls[0][1].onError(warning409));
    await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    expect(runMutate).toHaveBeenCalledTimes(2);
    expect(runMutate.mock.calls[1][0]).toEqual({
      id: "ri-1",
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("any other failure still toasts once, with no dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoicesPage />);
    await user.click(await screen.findByRole("button", { name: /run now/i }));
    act(() => runMutate.mock.calls[0][1].onError({ response: { status: 500, data: {} } }));
    expect(toast).toHaveBeenCalledWith({ title: "Failed to generate invoice", variant: "error" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
