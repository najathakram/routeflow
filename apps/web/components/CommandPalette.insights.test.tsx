import * as React from "react";
import userEvent from "@testing-library/user-event";
import { cleanup, renderWithProviders, screen } from "@/test-utils/render";
import { CommandPalette } from "./CommandPalette";

/**
 * SA-1087 PR-2: the palette's "Product insights" entry (the finder at /insights) follows the one
 * access rule (use-insights-access): staff without REPORTS, or a plan without flag.analytics, never
 * see it. Not a sidebar item.
 */
const pushMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ isLoading: false, data: undefined }),
}));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: false }),
}));
let mockAccess = true;
jest.mock("@/components/insights/use-insights-access", () => ({
  useInsightsAccess: () => mockAccess,
}));

beforeEach(() => {
  mockAccess = true;
  pushMock.mockReset();
});
afterEach(cleanup);

describe("CommandPalette — Product insights", () => {
  it("lists it and opens the finder", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    await user.click(await screen.findByText("Product insights"));
    expect(pushMock).toHaveBeenCalledWith("/insights");
  });

  it("finds it by what a person would type", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/search|type/i), "barcode");
    expect(await screen.findByText("Product insights")).toBeInTheDocument();
  });

  it("IN-2 / IN-3: absent when the viewer may not use insights", () => {
    mockAccess = false;
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByText("Product insights")).toBeNull();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
  });
});
