import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import DashboardLayout from "./layout";

/**
 * PKG-6 (apple-ux F18 + reduced motion), proven on the REAL rendered shell (L-205: never a
 * source-text scan). The mocks below only stub the data hooks the shell reads; the layout,
 * nav, aside and skip link are the real ones.
 */

jest.mock("next/navigation", () => ({
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
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

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

describe("DashboardLayout skip link (F18)", () => {
  it("S1: click cancels the hash navigation, focuses main, leaves the URL hash empty", () => {
    renderShell();
    const link = screen.getByText("Skip to content");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);

    const main = document.getElementById("main-content");
    expect(main).not.toBeNull();
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main);
    expect(window.location.hash).toBe("");
  });

  it("keeps href so the link still works without JS", () => {
    renderShell();
    expect(screen.getByText("Skip to content")).toHaveAttribute("href", "#main-content");
  });
});

describe("DashboardLayout reduced motion (S4)", () => {
  it("rail aside keeps its width transition but honours motion-reduce", () => {
    renderShell();
    const aside = screen.getByTestId("sidebar-aside");
    expect(aside).toHaveClass("transition-[width]");
    expect(aside).toHaveClass("motion-reduce:transition-none");
    expect(aside).toHaveClass("motion-reduce:duration-0");
  });

  it("every sidebar nav link and group toggle honours motion-reduce", () => {
    renderShell();
    const aside = screen.getByTestId("sidebar-aside");
    const links = within(aside).getAllByTestId("sidebar-nav-link");
    expect(links.length).toBeGreaterThan(0);
    links.forEach((l) => expect(l).toHaveClass("motion-reduce:transition-none"));
    const toggles = within(aside).getAllByTestId("sidebar-nav-group-toggle");
    expect(toggles.length).toBeGreaterThan(0);
    toggles.forEach((t) => expect(t).toHaveClass("motion-reduce:transition-none"));
  });

  it("collapse button honours motion-reduce and still toggles + persists", () => {
    renderShell();
    const btn = screen.getByLabelText("Collapse sidebar");
    expect(btn).toHaveClass("motion-reduce:transition-none");
    fireEvent.click(btn);
    expect(localStorage.getItem("rf-sidebar-collapsed")).toBe("true");
    expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
  });

  it("mobile drawer slides with animate-in but honours motion-reduce", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText(/open (navigation|menu)/i));
    const drawer = screen.getByTestId("sidebar-drawer-aside");
    expect(drawer).toHaveClass("animate-in");
    expect(drawer).toHaveClass("motion-reduce:animate-none");
  });
});
