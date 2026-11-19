import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

// UXG-R8: the shell feeds the menu its Product insights access; the rule itself is pinned in use-insights-access's own tests.
jest.mock("@/components/insights/use-insights-access", () => ({ useInsightsAccess: () => false }));

/**
 * POS-7a: Counter entry points in the shell (sidebar, drawer, g t). Reuses useCounterSaleGate.
 * PKG-6 (apple-ux F18 + reduced motion), proven on the REAL rendered shell (L-205: never a
 * source-text scan). The mocks below only stub the data hooks the shell reads; the layout,
 * nav, aside and skip link are the real ones.
 */

const mockPush = jest.fn();
let mockPath = "/orders";
let mockRole = "OPERATOR";
const mockGateCalls: Array<{ enabled?: boolean } | undefined> = [];
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));
let mockGate = { showButton: false };
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: (o?: { enabled?: boolean }) => {
    mockGateCalls.push(o);
    return mockGate;
  },
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
          <input data-testid="scan" />
          <div>page body</div>
        </DashboardLayout>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const group = (testId: string, label: string) =>
  within(screen.getByTestId(testId))
    .getAllByTestId("sidebar-nav-group-toggle")
    .find((b) => b.textContent?.trim() === label) as HTMLElement;
const linkTexts = (testId: string) =>
  within(screen.getByTestId(testId))
    .queryAllByTestId("sidebar-nav-link")
    .map((a) => a.textContent?.trim());

beforeEach(() => {
  localStorage.clear();
  mockPath = "/customers";
  mockRole = "OPERATOR";
  mockGate = { showButton: false };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("UX guide improvement 1: sidebar groups stay open", () => {
  it("the desktop rail keeps Orders open when Finance is opened", () => {
    renderShell();
    fireEvent.click(group("sidebar-aside", "Orders"));
    fireEvent.click(group("sidebar-aside", "Finance"));
    const links = linkTexts("sidebar-aside");
    expect(links).toContain("All Orders");
    expect(links).toContain("Invoices");
  });

  it("the phone drawer stays single-open: opening Finance closes Orders", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    fireEvent.click(group("sidebar-drawer-aside", "Orders"));
    expect(linkTexts("sidebar-drawer-aside")).toContain("All Orders");
    fireEvent.click(group("sidebar-drawer-aside", "Finance"));
    const links = linkTexts("sidebar-drawer-aside");
    expect(links).toContain("Invoices");
    expect(links).not.toContain("All Orders");
  });
});
