/**
 * #2167: when the realtime socket's token expired and the refresh failed, the portal says so
 * (a banner with "Sign in again") instead of leaving tracking silently frozen. The hook's own
 * expiry → refresh → reconnect path is pinned in useBuyerNotifications.expiry.test.ts; here the
 * hook is mocked and only the layout's reaction is checked. Fixtures are placeholders.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/buyer/portal/acme/orders/o-1",
}));

const mockLogout = jest.fn(async () => {});
jest.mock("@/lib/buyer-auth-context", () => ({
  // renderWithProviders mounts the provider; the layout reads the mocked hook.
  BuyerAuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useBuyerAuth: () => ({
    buyer: { id: "buyer-1", name: "Sample Buyer", email: "buyer@example.com" },
    isLoading: false,
    isAuthenticated: true,
    activeSeller: {
      linkId: "l-1",
      linkStatus: "ACTIVE",
      tenant: {
        id: "t-1",
        slug: "acme",
        name: "Acme Wholesale",
        logoKey: null,
        primaryColor: null,
      },
      customer: { id: "c-1", businessName: "Sample Buyer Co", email: null },
    },
    sellers: [],
    setActiveSeller: jest.fn(),
    logout: mockLogout,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => ({ totalQty: 0 }) }));
jest.mock("@/lib/api/buyer", () => ({ useBuyerExpiringAuthorizations: () => ({ data: [] }) }));

let mockSessionExpired = false;
jest.mock("@/lib/hooks/useBuyerNotifications", () => ({
  useBuyerNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markAllRead: jest.fn(),
    clearAll: jest.fn(),
    push: jest.fn(),
    sessionExpired: mockSessionExpired,
  }),
}));

import BuyerPortalLayout from "./layout";

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionExpired = false;
});

it("no banner while the realtime session is live", () => {
  renderWithProviders(
    <BuyerPortalLayout>
      <p>portal page</p>
    </BuyerPortalLayout>,
  );
  expect(screen.getByText("portal page")).toBeInTheDocument();
  expect(screen.queryByText(/your session has expired/i)).not.toBeInTheDocument();
});

it("an expired realtime session shows the banner; Sign in again logs out and goes to login", async () => {
  mockSessionExpired = true;
  const user = userEvent.setup();
  renderWithProviders(
    <BuyerPortalLayout>
      <p>portal page</p>
    </BuyerPortalLayout>,
  );

  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent(/your session has expired, so live updates have stopped/i);
  // The page itself stays on screen: the banner explains, it does not take over.
  expect(screen.getByText("portal page")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /sign in again/i }));
  await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
  expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/^\/buyer\/login\?redirect=/));
});
