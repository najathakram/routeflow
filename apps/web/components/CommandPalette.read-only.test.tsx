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
  const renderRO = (onClose = () => {}) =>
    render(
      <ReadOnlyGateProvider view={view("READ_ONLY")}>
        <CommandPalette open onClose={onClose} />
      </ReadOnlyGateProvider>,
    );

  // The rows use aria-disabled (not the disabled attribute) so they stay focusable and describable AND so the click
  // handler really runs - these tests exercise the handler guards, deleting either one fails them.
  it.each(["New Order", "New counter sale", "New Invoice"])(
    "%s is listed, aria-disabled, says why; a CLICK goes nowhere and keeps the palette open",
    (label) => {
      const onClose = jest.fn();
      renderRO(onClose);
      const row = screen.getByText(label).closest("button")!;
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(row).toHaveTextContent(LINE);
      fireEvent.click(row);
      expect(mockPush).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["New Order", "new order"],
    ["New counter sale", "counter sale"],
    ["New Invoice", "new invoice"],
  ])("%s: pressing ENTER on it goes nowhere and keeps the palette open", (_label, query) => {
    const onClose = jest.fn();
    renderRO(onClose);
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.change(input, { target: { value: query } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("navigation and non-write actions still work (click and Enter)", () => {
    const onClose = jest.fn();
    renderRO(onClose);
    fireEvent.click(screen.getByText("Reports"));
    expect(mockPush).toHaveBeenCalledWith("/finance/reports");
    expect(onClose).toHaveBeenCalledTimes(1);
    mockPush.mockClear();
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.change(input, { target: { value: "reports" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/finance/reports");
  });

  it("an ACTIVE workspace: the create actions work as before (click and Enter)", () => {
    render(
      <ReadOnlyGateProvider view={view("ACTIVE")}>
        <CommandPalette open onClose={() => {}} />
      </ReadOnlyGateProvider>,
    );
    const row = screen.getByText("New Invoice").closest("button")!;
    expect(row).not.toHaveAttribute("aria-disabled");
    fireEvent.click(row);
    expect(mockPush).toHaveBeenCalledWith("/invoices/new");
    mockPush.mockClear();
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.change(input, { target: { value: "new invoice" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/invoices/new");
  });
});
