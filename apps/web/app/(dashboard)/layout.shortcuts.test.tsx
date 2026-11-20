import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

// UXG-R8: the shell feeds the menu its Product insights access, off here; layout.insights-leaf.test.tsx pins that wiring.
jest.mock("@/components/insights/use-insights-access", () => ({ useInsightsAccess: () => false }));

/**
 * UXG-R8 T10: the "?" help lists only the shortcuts the signed-in menu can use.
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

beforeEach(() => {
  localStorage.clear();
  mockPath = "/dashboard";
  mockRole = "OPERATOR";
  mockGate = { showButton: false };
});
afterEach(() => cleanup());

const helpRows = () =>
  within(screen.getByText("Keyboard shortcuts").closest("div")!.parentElement!)
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

const openHelp = () => {
  renderShell();
  fireEvent.keyDown(window, { key: "?" });
};

describe("the ? help lists only keys that work for this person (UXG-R8 T10)", () => {
  it("a driver with runs sees exactly g r, g s, the palette and the help (g h would bounce, so it is not listed)", () => {
    mockRole = "DRIVER";
    openHelp();
    const rows = helpRows();
    expect(rows).toHaveLength(4);
    const text = rows.join("|");
    expect(text).toContain("Go to My Routes");
    expect(text).toContain("Go to My account");
    expect(text).toContain("Open command palette");
    expect(text).toContain("Show keyboard shortcuts");
    for (const gone of ["Dashboard", "Orders", "Customers", "Invoices", "Finance"])
      expect(text).not.toContain(gone);
  });

  it("an operator without the counter sees no counter key, with it sees g t", () => {
    openHelp();
    expect(helpRows().join("|")).not.toMatch(/Counter/);
    cleanup();
    mockGate = { showButton: true };
    openHelp();
    expect(helpRows().join("|")).toContain("Go to Counter");
  });

  it("an operator sees the page keys of the menu", () => {
    openHelp();
    const text = helpRows().join("|");
    for (const label of ["Dashboard", "Customers", "Invoices", "Finance overview", "Settings"])
      expect(text).toContain(`Go to ${label}`);
  });
});
