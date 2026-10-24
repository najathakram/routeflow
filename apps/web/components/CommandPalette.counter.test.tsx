import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

/** POS-7a: the "New counter sale" palette action is gated by useCounterSaleGate (same as the dashboard button). */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
const mockGateCalls: Array<{ enabled?: boolean } | undefined> = [];
let mockGate = { showButton: false };
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: (o?: { enabled?: boolean }) => {
    mockGateCalls.push(o);
    return mockGate;
  },
}));

beforeEach(() => {
  mockPush.mockClear();
  mockGate = { showButton: false };
  mockRole = "OPERATOR";
});
afterEach(cleanup);

describe("CommandPalette counter action", () => {
  it("is absent when the counter is off", () => {
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByText("New counter sale")).toBeNull();
    expect(screen.getByText("New Order")).toBeInTheDocument();
  });

  it("is present when enabled and goes to /orders/counter-sale", () => {
    mockGate = { showButton: true };
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.click(screen.getByText("New counter sale"));
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("is not offered to a customer even when enabled", () => {
    mockGate = { showButton: true };
    mockRole = "CUSTOMER";
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByText("New counter sale")).toBeNull();
  });

  it("does not enable the features fetch for a driver or customer", () => {
    for (const role of ["DRIVER", "CUSTOMER"]) {
      cleanup();
      mockGateCalls.length = 0;
      mockRole = role;
      render(<CommandPalette open onClose={() => {}} />);
      expect(mockGateCalls.length).toBeGreaterThan(0);
      expect(mockGateCalls.every((o) => o?.enabled === false)).toBe(true);
    }
  });
});
