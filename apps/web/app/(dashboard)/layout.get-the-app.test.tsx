import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

/** Row 559 W4: the avatar menu offers Get the app after Profile only when a link is ready and not in the shell. */

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
let mockLinks:
  { androidApkUrl: string | null; playStoreUrl: string | null; iosUrl: string | null } | undefined;
let mockShell = false;
jest.mock("@/lib/api/app-links", () => ({
  ...jest.requireActual("@/lib/api/app-links"),
  useAppLinks: () => ({ data: mockLinks }),
}));
jest.mock("@/lib/in-shell", () => ({ isInShell: () => mockShell }));
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
jest.mock("@/lib/presence-cookies", () => ({
  setLastPortalCookie: jest.fn(),
  hasOpPresence: () => true,
  hasBuyerPresence: () => false,
}));
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

function openMenu() {
  const trigger = screen.getByLabelText("Open user menu");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

const READY = { androidApkUrl: "https://example.test/app.apk", playStoreUrl: null, iosUrl: null };

beforeEach(() => {
  mockPush.mockClear();
  mockPath = "/orders";
  mockRole = "OPERATOR";
  mockGate = { showButton: false };
  mockLinks = READY;
  mockShell = false;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("avatar menu: Get the app", () => {
  it("the avatar menu shows Get the app after Profile only when a link is ready and not in the shell", async () => {
    renderShell();
    openMenu();
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim());
    const profile = items.findIndex((t) => /Profile/.test(t ?? ""));
    expect(profile).toBeGreaterThanOrEqual(0);
    expect(items[profile + 1]).toBe("Get the app");

    cleanup();
    mockLinks = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };
    renderShell();
    openMenu();
    await screen.findByRole("menuitem", { name: /Profile/i });
    expect(screen.queryByRole("menuitem", { name: "Get the app" })).toBeNull();

    cleanup();
    mockLinks = undefined; // still loading or an older api: fail closed
    renderShell();
    openMenu();
    await screen.findByRole("menuitem", { name: /Profile/i });
    expect(screen.queryByRole("menuitem", { name: "Get the app" })).toBeNull();

    cleanup();
    mockLinks = READY;
    mockShell = true;
    renderShell();
    openMenu();
    await screen.findByRole("menuitem", { name: /Profile/i });
    expect(screen.queryByRole("menuitem", { name: "Get the app" })).toBeNull();
  });

  it("opens /get-the-app", async () => {
    renderShell();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Get the app" }));
    expect(mockPush).toHaveBeenCalledWith("/get-the-app");
  });
});
