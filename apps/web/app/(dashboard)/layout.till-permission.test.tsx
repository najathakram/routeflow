import * as React from "react";
import { act, render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

/**
 * BO-07: the shell's Counter entries (sidebar, drawer, g t) follow the till permission. The REAL
 * useCounterSaleGate runs over the mocked API (the capability and GET /users/me/permissions): an operator
 * whose admin turned ORDERS off sees no Counter link and `g t` goes nowhere.
 */

const mockPush = jest.fn();
let mockPath = "/orders";
let mockRole = "OPERATOR";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment: { counter: "always", methods: ["PICKUP"] } } },
  }),
}));
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));
const mockUser = () => ({
  id: "u1",
  role: mockRole,
  firstName: "Ada",
  lastName: "Op",
  email: "a@example.com",
});
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: mockUser(),
    logout: jest.fn(),
  }),
  useOptionalAuth: () => ({ user: mockUser() }),
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
          <div>page body</div>
        </DashboardLayout>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
  mockPath = "/orders";
  mockRole = "OPERATOR";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/users/me/permissions"
          ? {
              role: mockRole,
              isAccountAdmin: false,
              groups: mockGroups,
              version: 1,
              mode: "shadow",
            }
          : {},
    }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("shell Counter entries and the operator's till permission", () => {
  it("an operator without ORDERS: no Counter in the sidebar or the drawer, and g t goes nowhere", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderShell();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {}); // the answer has landed: the entry must still be absent
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(within(screen.getByTestId("sidebar-aside")).queryByText("Counter")).toBeNull();
    expect(within(screen.getByTestId("sidebar-drawer-aside")).queryByText("Counter")).toBeNull();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "t" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("an operator with ORDERS: Counter is in the sidebar and drawer, and g t opens it", async () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    for (const id of ["sidebar-aside", "sidebar-drawer-aside"]) {
      const link = await within(screen.getByTestId(id)).findByText("Counter");
      expect(link.closest("a")).toHaveAttribute("href", "/orders/counter-sale");
    }
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "t" });
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("a tenant admin: Counter shows and permissions are never asked for", async () => {
    mockRole = "TENANT_ADMIN";
    renderShell();
    expect(
      await within(screen.getByTestId("sidebar-aside")).findByText("Counter"),
    ).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
