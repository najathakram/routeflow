import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import type { NavEntry } from "./_components/nav-config";
import { navLeaves, quickActions } from "./_components/nav-index";
import DashboardLayout from "./layout";

// SA-1228 F-2: the business's saved layout hides a page from the SIDEBAR only. The palette, the g keys and the quick
// actions keep the full visible menu, so hiding is never a permission (L-305).

let mockPath = "/orders";
const mockPush = jest.fn();
let paletteNav: NavEntry[] = [];
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("@/components/insights/use-insights-access", () => ({
  useInsightsAccess: () => false,
}));
jest.mock("@/lib/api/nav-layout", () => ({
  useNavLayout: () => ({ data: { pinned: [], order: [], hidden: ["/orders"] } }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: false }),
}));
jest.mock("@/lib/auth-context", () => ({
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
  CommandPalette: ({ nav }: { nav: NavEntry[] }) => {
    paletteNav = nav;
    return null;
  },
  useCommandPalette: () => ({ open: false, setOpen: jest.fn() }),
}));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));
jest.mock("@/components/DraftDock", () => ({ DraftDock: () => null }));
jest.mock("@/components/ReadOnlyBanner", () => ({ ReadOnlyBanner: () => null }));
jest.mock("./_components/gates/RouteGuard", () => ({
  RouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderShell() {
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockPush.mockClear();
});

describe("SA-1228 F-2: a hidden page is hidden from the menu, never blocked", () => {
  it("the page still renders and the sidebar has no All Orders link", () => {
    renderShell();
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(within(screen.getByTestId("sidebar-aside")).queryByText("All Orders")).toBeNull();
  });

  it("the palette keeps /orders and New Order, and g then o still opens /orders", () => {
    renderShell();
    expect(navLeaves(paletteNav).map((l) => l.href)).toContain("/orders");
    expect(quickActions(paletteNav, { staff: true, readOnly: false }).map((a) => a.id)).toContain(
      "act-new-order",
    );
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "o" });
    expect(mockPush).toHaveBeenCalledWith("/orders");
  });
});
