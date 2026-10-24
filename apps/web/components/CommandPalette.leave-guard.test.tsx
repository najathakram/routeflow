import * as React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import {
  confirmCounterLeave,
  getCounterLeaveRequest,
  setCounterCartBusy,
  setCounterCartHasLines,
} from "@/lib/counter-cart-signal";

/** POS-7: a palette selection is one of the ways to leave the counter; it must not while a sale is being recorded. */
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

beforeEach(() => mockPush.mockClear());
afterEach(() => {
  cleanup();
  act(() => setCounterCartBusy(false));
  act(() => setCounterCartHasLines(false));
});

describe("CommandPalette leave guard", () => {
  it("a click selection does not navigate while busy", () => {
    render(<CommandPalette open onClose={() => {}} />);
    act(() => setCounterCartBusy(true));
    fireEvent.click(screen.getByText("New Order"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("an Enter selection does not navigate while busy", () => {
    render(<CommandPalette open onClose={() => {}} />);
    act(() => setCounterCartBusy(true));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("navigates normally when not busy", () => {
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.click(screen.getByText("New Order"));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("a selection with lines raises the Discard request instead of navigating", () => {
    render(<CommandPalette open onClose={() => {}} />);
    act(() => setCounterCartHasLines(true));
    fireEvent.click(screen.getByText("New Order"));
    expect(mockPush).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(true);
    act(() => confirmCounterLeave());
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});
