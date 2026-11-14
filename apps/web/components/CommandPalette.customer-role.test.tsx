import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

/** REG-B1: starting an order is a staff action; a customer's palette has no "New Order" command. Harness as CommandPalette.counter.test.tsx. */
jest.mock("@/components/insights/use-insights-access", () => ({ useInsightsAccess: () => false }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => ({ data: undefined }) }));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: false }),
}));

beforeEach(() => {
  mockRole = "OPERATOR";
});
afterEach(cleanup);

describe("REG-B1 CommandPalette New Order by role", () => {
  it("REG-B1 a CUSTOMER's palette has no New Order command", () => {
    mockRole = "CUSTOMER";
    render(<CommandPalette open onClose={() => {}} />);
    expect({ label: "New Order", count: screen.queryAllByText("New Order").length }).toEqual({
      label: "New Order",
      count: 0,
    });
  });

  it("REG-B1 an OPERATOR twin has the New Order command", () => {
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryAllByText("New Order").length).toBeGreaterThanOrEqual(1);
  });

  it("REG-B1 a SUPER_ADMIN keeps the New Order command", () => {
    mockRole = "SUPER_ADMIN";
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryAllByText("New Order").length).toBeGreaterThanOrEqual(1);
  });
});
