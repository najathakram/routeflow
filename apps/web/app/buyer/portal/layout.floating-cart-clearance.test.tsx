import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";

let mockCartQty = 0;
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/buyer/portal/acme/orders/o-1",
}));
jest.mock("@/lib/buyer-auth-context", () => ({
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
    logout: jest.fn(async () => {}),
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => ({ totalQty: mockCartQty }) }));
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

/**
 * W-669 (604 recheck Q26): on the buyer order detail at phone width the global floating cart button (fixed, 56 px, 24 px
 * from the bottom) sat over the order's last row and hid its subtotal ("$2…" in the shot). While that button shows, the
 * scrolling main area keeps a bottom clearance the button's height plus its offset, so the last row scrolls clear of it.
 */
const mainEl = () => document.querySelector("main") as HTMLElement;

describe("W-669: the floating cart button never covers the page's last row", () => {
  beforeEach(() => {
    mockCartQty = 0;
  });

  it("with items in the cart the button shows and main keeps a bottom clearance (pb-24)", () => {
    mockCartQty = 3;
    renderWithProviders(
      <BuyerPortalLayout>
        <div>page</div>
      </BuyerPortalLayout>,
    );
    expect(screen.getByRole("button", { name: /View cart \(3 items\)/ })).toBeInTheDocument();
    expect(mainEl().className).toMatch(/(^|\s)pb-24(\s|$)/);
  });

  it("with an empty cart there is no button and no extra clearance", () => {
    renderWithProviders(
      <BuyerPortalLayout>
        <div>page</div>
      </BuyerPortalLayout>,
    );
    expect(screen.queryByRole("button", { name: /View cart/ })).toBeNull();
    expect(mainEl().className).not.toMatch(/(^|\s)pb-24(\s|$)/);
  });
});
