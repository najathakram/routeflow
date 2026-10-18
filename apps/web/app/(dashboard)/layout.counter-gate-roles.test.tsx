import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

/**
 * W20-L2: the REAL useCounterSaleGate under the shell with cached add-on data: non-staff never get g t or its help entry.
 * PKG-6 (apple-ux F18 + reduced motion), proven on the REAL rendered shell (L-205: never a
 * source-text scan). The mocks below only stub the data hooks the shell reads; the layout,
 * nav, aside and skip link are the real ones.
 */

const mockPush = jest.fn();
let mockPath = "/orders";
let mockRole = "OPERATOR";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));
let mockCounter = "optional";
jest.mock("@/lib/tenant-features", () => ({
  // The CACHED answer is always there (as after a staff session on this tenant): only `enabled` can hide it.
  useTenantFeatures: () => ({
    data: { capabilities: { fulfilment: { counter: mockCounter, methods: ["ROUTE"] } } },
    isLoading: false,
  }),
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

function press(key: string, target: Element | Window = window) {
  fireEvent.keyDown(target, { key });
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
  mockPush.mockClear();
  mockPath = "/orders";
  mockRole = "OPERATOR";
  mockCounter = "optional";
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const openHelp = () => {
  press("?");
  return screen.queryAllByText("Go to Counter sale");
};

describe("g t and its help entry with cached counter data (W20-L2)", () => {
  it.each(["DRIVER", "CUSTOMER"])("%s: g t does nothing and no help entry", (role) => {
    mockRole = role;
    renderShell();
    press("g");
    press("t");
    expect(mockPush).not.toHaveBeenCalledWith("/orders/counter-sale");
    expect(openHelp()).toHaveLength(0);
  });

  it("OPERATOR: g t goes to the counter and the help entry is listed", () => {
    renderShell();
    press("g");
    press("t");
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
    expect(openHelp().length).toBeGreaterThan(0);
  });
});
