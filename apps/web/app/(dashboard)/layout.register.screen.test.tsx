import * as React from "react";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import { setCounterCartBusy, setCounterCartHasLines } from "@/lib/counter-cart-signal";
import { resetCounterLandingForTests } from "@/lib/counter-device-pref";
import { setImpersonation, clearImpersonation } from "@/lib/impersonation";
import DashboardLayout from "./layout";
import { CounterSaleScreen } from "./orders/_components/CounterSaleScreen";

/**
 * POS-7: the counter "register look" and the per-device "open the counter" preference, proven on the REAL
 * rendered shell (L-205). Only the data hooks the shell reads are stubbed. Register mode = a route-derived flag
 * (true only on /orders/counter-sale): the rail uses its existing 64 px collapsed mode (a peek toggle expands it
 * WITHOUT writing rf-sidebar-collapsed), and a slim header replaces the full one.
 */

const COUNTER = "/orders/counter-sale";
const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockPath = "/orders";
let mockRole = "OPERATOR";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push: mockPush, replace: mockReplace, prefetch: jest.fn() }),
}));
let mockGate: Record<string, unknown> = {
  showButton: true,
  opensAsCounter: true,
  offerShipInstead: true,
  capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
} as typeof mockGate;
const mockLogout = jest.fn();
const mockSetPalette = jest.fn();
let mockDriveMode = false;
const mockSetDriveMode = jest.fn();
const BLOCKED = /A sale is in progress\. Wait for the receipt or check its status before leaving\./;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => mockGate,
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async () => ({
    product: { id: "p1", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null },
    source: "sku",
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
jest.mock("@/lib/auth-context", () => ({
  useOptionalAuth: () => ({ user: { id: "u1", tenantSlug: "acme" } }),
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: {
      id: "u1",
      role: mockRole,
      username: "ada.clerk",
      email: "a@example.com",
      canActAsDriver: true,
    },
    logout: mockLogout,
  }),
}));
jest.mock("@/components/tenant-provider", () => ({
  useTenant: () => ({ branding: { businessName: "Acme Wholesale" } }),
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
jest.mock("@/lib/api/authorizations", () => ({ useExpiringAuthorizations: () => ({ data: [] }) }));
jest.mock("@/lib/api/portal-approvals", () => ({
  usePendingPortalApprovals: () => ({ data: [] }),
}));
jest.mock("@/lib/hooks/useRealtimeUpdates", () => ({ useRealtimeUpdates: () => undefined }));
let mockNotifications: unknown[] = [];
jest.mock("@/lib/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: mockNotifications,
    unreadCount: 0,
    markAllRead: jest.fn(),
    clear: jest.fn(),
  }),
}));
jest.mock("@/lib/drive-mode", () => ({
  useDriveMode: () => ({ driveMode: mockDriveMode, setDriveMode: mockSetDriveMode }),
}));
jest.mock("@/lib/presence-cookies", () => ({
  setLastPortalCookie: jest.fn(),
  hasOpPresence: () => true,
  hasBuyerPresence: () => false,
}));
jest.mock("@/components/TenantLogo", () => ({ TenantLogo: () => <span>logo</span> }));
jest.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => null,
  useCommandPalette: () => ({ open: false, setOpen: mockSetPalette }),
}));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));
jest.mock("@/components/DraftDock", () => ({ DraftDock: () => null }));
jest.mock("@/components/ReadOnlyBanner", () => ({ ReadOnlyBanner: () => null }));
jest.mock("./_components/gates/RouteGuard", () => ({
  RouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// One QueryClient per test so a re-render (a route change) keeps the same tree.
let client = createTestQueryClient();
const ui = () => (
  <QueryClientProvider client={client}>
    <I18nProvider>
      <DashboardLayout>
        <CounterSaleScreen />
      </DashboardLayout>
    </I18nProvider>
  </QueryClientProvider>
);

/** Render at `path`; `go(path)` is a client-side route change on the SAME mounted shell. */
function mount(path: string) {
  mockPath = path;
  const view = render(ui());
  const go = (next: string) => {
    mockPath = next;
    view.rerender(ui());
  };
  return { ...view, go };
}

/** POS-7: the REAL CounterSaleScreen under the REAL shell - a g shortcut with lines in the cart opens the same Discard dialog. */
describe("g shortcut with the real counter screen", () => {
  const press = (...keys: string[]) => keys.forEach((key) => fireEvent.keyDown(window, { key }));

  it("scanning a line then pressing g c asks 'Discard this sale?' instead of leaving", async () => {
    mount(COUNTER);
    const field = await screen.findByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "COLA" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(screen.getByText(/Cola/)).toBeInTheDocument());
    (document.activeElement as HTMLElement | null)?.blur();
    press("g", "c");
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledWith("/customers");
  });

  it("with an empty cart g c leaves directly", async () => {
    mount(COUNTER);
    await screen.findByLabelText("Scan or search items");
    press("g", "c");
    expect(mockPush).toHaveBeenCalledWith("/customers");
    expect(screen.queryByText("Discard this sale?")).toBeNull();
  });
});
