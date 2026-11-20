import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

// UXG-R8 C1 review F1: this file pins the wiring from useInsightsAccess() into the menu.
let mockInsights = false;
jest.mock("@/components/insights/use-insights-access", () => ({
  useInsightsAccess: () => mockInsights,
}));

/**
 * The layout passes useInsightsAccess() to buildOperatorNav as `insightsAccess`. These cases mount the real
 * shell (only data hooks are stubbed) on a plan with flag.reports and flag.analytics, so the Reports & analytics
 * group shows, and prove the menu follows the hook both ways.
 */

let mockPath = "/orders";
let mockRole = "OPERATOR";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", role: mockRole, firstName: "Ada", lastName: "Op", email: "a@example.com" },
    logout: jest.fn(),
  }),
}));
jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({
    data: { flags: ["flag.reports", "flag.analytics"] },
    isSuccess: true,
    isError: false,
  }),
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

const navLabels = (testId: string) =>
  Array.from(
    screen
      .getByTestId(testId)
      .querySelectorAll(
        '[data-testid="sidebar-nav-link"],[data-testid="sidebar-nav-group-toggle"]',
      ),
  ).map((a) => a.textContent?.trim());

beforeEach(() => {
  mockPath = "/finance/reports";
  mockRole = "OPERATOR";
  mockInsights = false;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("UXG-R8 C1 (review F1): the shell feeds useInsightsAccess() into the menu", () => {
  it("hook false: no Product insights in the sidebar or the drawer", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(navLabels("sidebar-aside")).toContain("Analytics");
    for (const id of ["sidebar-aside", "sidebar-drawer-aside"]) {
      expect(within(screen.getByTestId(id)).queryByText("Product insights")).toBeNull();
    }
  });

  it("hook true: Product insights is the last child of Reports & analytics, in the sidebar and the drawer", () => {
    mockInsights = true;
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    for (const id of ["sidebar-aside", "sidebar-drawer-aside"]) {
      const link = within(screen.getByTestId(id)).getByText("Product insights").closest("a");
      expect(link).toHaveAttribute("href", "/insights");
    }
    const labels = navLabels("sidebar-aside");
    const group = labels.indexOf("Reports & analytics");
    expect(labels.slice(group, labels.indexOf("Product insights") + 1)).toEqual([
      "Reports & analytics",
      "Reports",
      "Analytics",
      "Product insights",
    ]);
  });
});
