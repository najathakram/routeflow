/**
 * The buyer navigation sheet slides in with an eased curve and does not move for a visitor who
 * asks for reduced motion. jsdom has no Tailwind stylesheet, so the panel's classes are the
 * observable: `motion-reduce:animate-none` switches the slide off under
 * `prefers-reduced-motion: reduce`, and an explicit animation-timing-function replaces the
 * default curve. Fixtures are placeholders.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";

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

it("the open navigation sheet is eased and its slide is switched off for reduced motion", async () => {
  const user = userEvent.setup();
  renderWithProviders(
    <BuyerPortalLayout>
      <p>portal page</p>
    </BuyerPortalLayout>,
  );
  await user.click(screen.getByRole("button", { name: /open navigation menu/i }));

  const dialog = screen.getByRole("dialog", { name: "Navigation" });
  const panel = dialog.querySelector("aside");
  expect(panel).not.toBeNull();
  const classes = (panel as HTMLElement).className.split(/\s+/);

  // Reduced motion: the slide animation is removed (no movement).
  expect(classes).toContain("motion-reduce:animate-none");
  // Normal case: an explicit, non-linear curve for the movement, 150-400 ms.
  expect(classes.some((c) => /^\[animation-timing-function:cubic-bezier\(/.test(c))).toBe(true);
  expect(classes.some((c) => /^duration-(150|200|250|300|350|400)$/.test(c))).toBe(true);
  // Still a labelled, focusable dialog with the nav inside.
  expect(within(dialog).getByRole("button", { name: /close/i })).toBeInTheDocument();
});
