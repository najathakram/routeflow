/**
 * W-1296: picking another seller in the sidebar's "Your sellers" list lands the same way the
 * seller list on /buyer/portal does: through the portal home (?then=orders), so a buyer with 0
 * counted orders at that seller lands on Invoices, not the dashboard (SA-1211 A1.2).
 * Fixtures are placeholders.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/buyer/portal/acme/orders",
}));

const seller = (id: string, slug: string, name: string) => ({
  linkId: `l-${id}`,
  linkStatus: "ACTIVE",
  tenant: { id: `t-${id}`, slug, name, logoKey: null, primaryColor: null },
  customer: { id: `c-${id}`, businessName: "Sample Buyer Co", email: null },
});
const acme = seller("1", "acme", "Acme Wholesale");
const north = seller("2", "acme-north", "Northline Supply");

const mockSetActiveSeller = jest.fn();
jest.mock("@/lib/buyer-auth-context", () => ({
  BuyerAuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useBuyerAuth: () => ({
    buyer: { id: "buyer-1", name: "Sample Buyer", email: "buyer@example.com" },
    isLoading: false,
    isAuthenticated: true,
    activeSeller: acme,
    sellers: [acme, north],
    setActiveSeller: mockSetActiveSeller,
    logout: jest.fn(async () => {}),
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => ({ totalQty: 0 }) }));
jest.mock("@/lib/api/buyer", () => ({ useBuyerExpiringAuthorizations: () => ({ data: [] }) }));
jest.mock("@/lib/hooks/useBuyerNotifications", () => ({
  useBuyerNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markAllRead: jest.fn(),
    clearAll: jest.fn(),
    push: jest.fn(),
    sessionExpired: false,
  }),
}));

import BuyerPortalLayout from "./layout";

beforeEach(() => jest.clearAllMocks());

async function switchToNorth() {
  const user = userEvent.setup();
  renderWithProviders(
    <BuyerPortalLayout>
      <p>portal page</p>
    </BuyerPortalLayout>,
  );
  // The sidebar renders twice (desktop rail and phone drawer); either copy uses one handler.
  await user.click(screen.getAllByRole("button", { name: /your sellers/i })[0]);
  await user.click(screen.getAllByRole("button", { name: /northline supply/i })[0]);
}

it("switching seller lands through the portal home", async () => {
  await switchToNorth();
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith("/buyer/portal/acme-north?then=orders");
});

it("the switcher sets the active seller first", async () => {
  await switchToNorth();
  expect(mockSetActiveSeller).toHaveBeenCalledWith(north);
  expect(mockSetActiveSeller.mock.invocationCallOrder[0]).toBeLessThan(
    mockPush.mock.invocationCallOrder[0],
  );
});
