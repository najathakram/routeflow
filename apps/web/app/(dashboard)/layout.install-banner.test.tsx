import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

/**
 * SA-1069 A-2 P-1: in an iPhone browser the fixed "Install RouteFlow" banner covered "Complete & show
 * receipt" and "Complete & next sale" at the till. The class fix is to stop mounting it on every staff
 * screen (the shell), so no screen with a bottom action needs an opt-out; the staff home mounts it
 * (dashboard/page.install-banner.test.tsx). Proven on the REAL shell and the REAL banner (L-205): only
 * the data hooks the shell reads are stubbed, and the user agent is an iPhone's, which is the one that
 * shows the banner without a `beforeinstallprompt` event.
 */

let mockPath = "/orders/counter-sale";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  useOptionalAuth: () => null,
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", role: "OPERATOR", firstName: "Ada", lastName: "Op", email: "a@example.com" },
    logout: jest.fn(),
  }),
}));
jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({ data: { flags: [] }, isSuccess: true, isError: false }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ isLoading: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  SALES_AGENTS_ADDON: "sales_agents",
  useRoutesAccess: () => ({ enabled: true, resolved: true }),
  useDeliveryAccess: () => ({ enabled: true, resolved: true }),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/api/authorizations", () => ({
  useExpiringAuthorizations: () => ({ data: [] }),
}));
jest.mock("@/lib/api/portal-approvals", () => ({
  usePendingPortalApprovals: () => ({ data: [] }),
}));
jest.mock("@/lib/hooks/useRealtimeUpdates", () => ({ useRealtimeUpdates: () => undefined }));
jest.mock("@/lib/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markAllRead: jest.fn(),
    clear: jest.fn(),
  }),
}));
jest.mock("@/lib/drive-mode", () => ({
  useDriveMode: () => ({ driveMode: false, setDriveMode: jest.fn() }),
}));
jest.mock("@/lib/presence-cookies", () => ({ setLastPortalCookie: jest.fn() }));
jest.mock("@/components/TenantLogo", () => ({ TenantLogo: () => <span>logo</span> }));
jest.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => null,
  useCommandPalette: () => ({ open: false, setOpen: jest.fn() }),
}));
jest.mock("@/components/DraftDock", () => ({ DraftDock: () => null }));
jest.mock("@/components/ReadOnlyBanner", () => ({ ReadOnlyBanner: () => null }));
jest.mock("./_components/gates/RouteGuard", () => ({
  RouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const realUa = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

beforeEach(() => {
  Object.defineProperty(window.navigator, "userAgent", { value: IPHONE_UA, configurable: true });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  if (realUa) Object.defineProperty(window.navigator, "userAgent", realUa);
  else delete (window.navigator as unknown as Record<string, unknown>).userAgent;
});

function renderShellAt(path: string) {
  mockPath = path;
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <I18nProvider>
        <DashboardLayout>
          <div>page body</div>
        </DashboardLayout>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("DashboardLayout install banner (SA-1069 A-2 P-1)", () => {
  it("P1-1: the till on an iPhone has no Install RouteFlow banner over its bottom actions", () => {
    renderShellAt("/orders/counter-sale");
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.queryByText(/Install RouteFlow/)).toBeNull();
  });

  it.each(["/orders", "/settings/invoicing", "/products"])(
    "P1-2: %s, a staff screen with a bottom action, has none either",
    (path) => {
      renderShellAt(path);
      expect(screen.queryByText(/Install RouteFlow/)).toBeNull();
    },
  );
});
