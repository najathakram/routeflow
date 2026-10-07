import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

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
  mockGateCalls.length = 0;
  mockGate = { showButton: false };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("POS-7a counter entry", () => {
  it("hides Counter in the sidebar and drawer when the counter is off, and pins the nav inventory", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    const aside = screen.getByTestId("sidebar-aside");
    expect(within(aside).queryByText("Counter")).toBeNull();
    expect(within(screen.getByTestId("sidebar-drawer-aside")).queryByText("Counter")).toBeNull();
    expect(navLabels("sidebar-aside")).toEqual([
      "Dashboard",
      "Orders",
      "All Orders",
      "Dispatch",
      "Customers",
      "Warehouse",
      "Finance",
      "Settings",
    ]);
  });

  it("shows Counter -> /orders/counter-sale in sidebar and drawer, first child of Orders, nothing else changed", () => {
    renderShell();
    const before = navLabels("sidebar-aside");
    cleanup();
    mockGate = { showButton: true };
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    for (const id of ["sidebar-aside", "sidebar-drawer-aside"]) {
      const link = within(screen.getByTestId(id)).getByText("Counter").closest("a");
      expect(link).toHaveAttribute("href", "/orders/counter-sale");
    }
    const after = navLabels("sidebar-aside");
    expect(after.filter((l) => l !== "Counter")).toEqual(before);
    expect(after.length).toBe(before.length + 1);
    expect(after.indexOf("Counter")).toBe(after.indexOf("Orders") + 1);
    expect(after.indexOf("All Orders")).toBe(after.indexOf("Counter") + 1);
  });

  it("g t goes to the counter when enabled", () => {
    mockGate = { showButton: true };
    renderShell();
    press("g");
    press("t");
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("g t does nothing when the counter is off", () => {
    renderShell();
    press("g");
    press("t");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("typing g then t inside an input never triggers g t", () => {
    mockGate = { showButton: true };
    renderShell();
    const scan = screen.getByTestId("scan");
    press("g", scan);
    press("t", scan);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("typing g then t inside a textarea or contenteditable never triggers g t", () => {
    mockGate = { showButton: true };
    renderShell();
    const ta = document.createElement("textarea");
    const ce = document.createElement("div");
    ce.contentEditable = "true";
    Object.defineProperty(ce, "isContentEditable", { value: true });
    document.body.append(ta, ce);
    for (const el of [ta, ce]) {
      press("g", el);
      press("t", el);
    }
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("existing g o still goes to Orders", () => {
    renderShell();
    press("g");
    press("o");
    expect(mockPush).toHaveBeenCalledWith("/orders");
  });

  it("exactly ONE nav item is active: Counter on /orders/counter-sale, All Orders on /orders", () => {
    mockGate = { showButton: true };
    const active = () =>
      Array.from(screen.getByTestId("sidebar-aside").querySelectorAll('[aria-current="page"]')).map(
        (a) => a.textContent?.trim(),
      );
    mockPath = "/orders/counter-sale";
    renderShell();
    expect(active()).toEqual(["Counter"]);
    cleanup();
    mockPath = "/orders";
    renderShell();
    expect(active()).toEqual(["All Orders"]);
  });

  it("staff ask the gate to fetch; driver and customer renders never enable it", () => {
    renderShell();
    expect(mockGateCalls.every((o) => o?.enabled === true)).toBe(true);
    for (const role of ["DRIVER", "CUSTOMER"]) {
      cleanup();
      mockGateCalls.length = 0;
      mockRole = role;
      renderShell();
      expect(mockGateCalls.length).toBeGreaterThan(0);
      expect(mockGateCalls.every((o) => o?.enabled === false)).toBe(true);
    }
  });
});
