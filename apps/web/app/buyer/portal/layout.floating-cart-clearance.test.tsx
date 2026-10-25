import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";

let mockCartQty = 0;
let mockPath = "/buyer/portal/acme/orders/o-1";
let mockHasSeller = true;
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => mockPath,
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  BuyerAuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useBuyerAuth: () => ({
    buyer: { id: "buyer-1", name: "Sample Buyer", email: "buyer@example.com" },
    isLoading: false,
    isAuthenticated: true,
    activeSeller: !mockHasSeller
      ? null
      : {
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
    mockPath = "/buyer/portal/acme/orders/o-1";
    mockHasSeller = true;
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

  // #3669 review NITs: the two cases that hide the button were not pinned.
  it("on the cart page itself there is no button and no clearance", () => {
    mockCartQty = 3;
    mockPath = "/buyer/portal/acme/cart";
    renderWithProviders(
      <BuyerPortalLayout>
        <div>page</div>
      </BuyerPortalLayout>,
    );
    expect(screen.queryByRole("button", { name: /View cart/ })).toBeNull();
    expect(mainEl().className).not.toMatch(/(^|\s)pb-24(\s|$)/);
  });

  it("with no active seller there is no button, whatever the cart holds", () => {
    mockCartQty = 3;
    mockHasSeller = false;
    renderWithProviders(
      <BuyerPortalLayout>
        <div>page</div>
      </BuyerPortalLayout>,
    );
    expect(screen.queryByRole("button", { name: /View cart/ })).toBeNull();
  });
});

/**
 * W-753: the shop page's sticky cart bar never stuck. The shell grows with its content, so the WINDOW scrolls, but `main`
 * (overflow-auto) and its column (overflow-hidden) were scroll containers that never scroll, and a sticky element sticks
 * to its nearest scroll container. Neither may be one now (min-w-0 keeps wide content from stretching the column). The
 * floating cart sat at z-50, later in the DOM than an in-page overlay at z-50 (the "Connect to a Seller" modal), so it
 * drew over the overlay; it now sits below the overlay layer. On the shop page the sticky bar's "View Cart" replaces it
 * (the button would sit on top of the bar's button).
 */
describe("W-753: the shop's sticky cart bar sticks, and the floating cart stays under overlays", () => {
  beforeEach(() => {
    mockCartQty = 3;
    mockPath = "/buyer/portal/acme/orders/o-1";
    mockHasSeller = true;
  });
  const render = () =>
    renderWithProviders(
      <BuyerPortalLayout>
        <div>page</div>
      </BuyerPortalLayout>,
    );
  const SCROLLER = /(^|\s)overflow-(auto|hidden|scroll|y-auto|y-hidden|y-scroll)(\s|$)/;

  it("neither main nor its column is a scroll container (the window scrolls)", () => {
    render();
    expect(mainEl().className).not.toMatch(SCROLLER);
    expect((mainEl().parentElement as HTMLElement).className).not.toMatch(SCROLLER);
    expect(mainEl().className).toMatch(/(^|\s)min-w-0(\s|$)/);
    expect((mainEl().parentElement as HTMLElement).className).toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it("the floating cart sits below the overlay layer (z-40, not z-50)", () => {
    render();
    const fab = screen.getByRole("button", { name: /View cart \(3 items\)/ });
    expect(fab.className).toMatch(/(^|\s)z-40(\s|$)/);
    expect(fab.className).not.toMatch(/(^|\s)z-50(\s|$)/);
  });

  it("on the shop page the floating cart is hidden (the sticky bar's View Cart takes its place)", () => {
    mockPath = "/buyer/portal/acme/shop";
    render();
    expect(screen.queryByRole("button", { name: /View cart \(/ })).toBeNull();
    expect(mainEl().className).not.toMatch(/(^|\s)pb-24(\s|$)/);
  });
});
