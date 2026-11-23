import * as React from "react";
import userEvent from "@testing-library/user-event";
import { cleanup, renderWithProviders, screen } from "@/test-utils/render";
import { navFor } from "@/test-utils/nav";
import { CommandPalette } from "./CommandPalette";

/**
 * SA-1087 PR-2, as amended by UXG-R8: the "Product insights" row (the finder at /insights) is the menu's own
 * entry, so it follows the one access rule the layout feeds the menu (use-insights-access): staff without
 * REPORTS, or a plan without flag.analytics, never see it.
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

let mockAccess = true;
const palette = () => (
  <CommandPalette open onClose={() => {}} nav={navFor({ insightsAccess: mockAccess })} />
);

beforeEach(() => {
  mockAccess = true;
  pushMock.mockReset();
});
afterEach(cleanup);

describe("CommandPalette: Product insights", () => {
  it("lists it and opens the finder", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(palette());
    await user.click(await screen.findByText("Product insights"));
    expect(pushMock).toHaveBeenCalledWith("/insights");
  });

  it("finds it by what a person would type", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(palette());
    await user.type(screen.getByPlaceholderText(/search|type/i), "barcode");
    expect(await screen.findByText("Product insights")).toBeInTheDocument();
  });

  it("IN-2 / IN-3: absent when the viewer may not use insights", () => {
    mockAccess = false;
    renderWithProviders(palette());
    expect(screen.queryByText("Product insights")).toBeNull();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
  });
});
