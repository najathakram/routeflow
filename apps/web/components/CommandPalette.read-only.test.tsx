import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SubscriptionView } from "@routeflow/types";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { CommandPalette } from "./CommandPalette";

/**
 * SA-733r6 (B4): while the workspace is read-only the palette's create actions (New Order, New counter sale, New
 * Invoice) stay listed but disabled with the shared line - no navigation to a dead-end create screen. Navigation
 * (Reports, Settings ...) and the non-write actions are untouched.
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => ({ showButton: true }) }));

const view = (status: string) =>
  ({ status, billingContactName: "Dana" }) as unknown as SubscriptionView;
const LINE = "Not available while read-only. Dana can restore it.";

beforeEach(() => mockPush.mockClear());
afterEach(cleanup);

describe("CommandPalette in a read-only workspace", () => {
  it.each(["New Order", "New counter sale", "New Invoice"])(
    "%s is listed, disabled, and says why; selecting it goes nowhere",
    (label) => {
      render(
        <ReadOnlyGateProvider view={view("READ_ONLY")}>
          <CommandPalette open onClose={() => {}} />
        </ReadOnlyGateProvider>,
      );
      const row = screen.getByText(label).closest("button")!;
      expect(row).toBeDisabled();
      expect(row).toHaveTextContent(LINE);
      fireEvent.click(row);
      expect(mockPush).not.toHaveBeenCalled();
    },
  );

  it("navigation and non-write actions still work", () => {
    render(
      <ReadOnlyGateProvider view={view("READ_ONLY")}>
        <CommandPalette open onClose={() => {}} />
      </ReadOnlyGateProvider>,
    );
    fireEvent.click(screen.getByText("Reports"));
    expect(mockPush).toHaveBeenCalledWith("/finance/reports");
  });

  it("an ACTIVE workspace: the create actions work as before", () => {
    render(
      <ReadOnlyGateProvider view={view("ACTIVE")}>
        <CommandPalette open onClose={() => {}} />
      </ReadOnlyGateProvider>,
    );
    const row = screen.getByText("New Invoice").closest("button")!;
    expect(row).toBeEnabled();
    fireEvent.click(row);
    expect(mockPush).toHaveBeenCalledWith("/invoices/new");
  });
});
