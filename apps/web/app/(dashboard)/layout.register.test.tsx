import * as React from "react";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import { setCounterCartHasLines } from "@/lib/counter-cart-signal";
import { resetCounterLandingForTests } from "@/lib/counter-device-pref";
import { setImpersonation, clearImpersonation } from "@/lib/impersonation";
import DashboardLayout from "./layout";

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
let mockGate = { showButton: true };
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => mockGate }));
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", role: mockRole, username: "ada.clerk", email: "a@example.com" },
    logout: jest.fn(),
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

// One QueryClient per test so a re-render (a route change) keeps the same tree.
let client = createTestQueryClient();
const ui = () => (
  <QueryClientProvider client={client}>
    <I18nProvider>
      <DashboardLayout>
        <div>page body</div>
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

const aside = () => screen.getByTestId("sidebar-aside");
const railCollapsed = () => aside().className.includes("lg:w-16");
const railExpanded = () => aside().className.includes("lg:w-60");
const registerHeader = () => screen.getByTestId("register-header");
const FOCUSABLE =
  'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

let setItemKeys: string[] = [];
let realSetItem: typeof Storage.prototype.setItem;
beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  mockPath = "/orders";
  mockRole = "OPERATOR";
  mockGate = { showButton: true };
  client = createTestQueryClient();
  setItemKeys = [];
  realSetItem = Storage.prototype.setItem;
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    k: string,
    v: string,
  ) {
    setItemKeys.push(k);
    return realSetItem.call(this, k, v);
  });
});
afterEach(() => {
  cleanup();
  act(() => setCounterCartHasLines(false));
  clearImpersonation();
  jest.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetCounterLandingForTests();
});

describe("register flag (route-derived)", () => {
  it("is on only at /orders/counter-sale", () => {
    mount(COUNTER);
    expect(screen.getByRole("button", { name: "Exit counter" })).toBeInTheDocument();
    cleanup();
    for (const p of ["/orders", "/orders/abc", "/dashboard", "/customers"]) {
      mount(p);
      expect(screen.queryByRole("button", { name: "Exit counter" })).toBeNull();
      cleanup();
    }
  });
});

describe("rail in register mode", () => {
  it("is the 64 px collapsed rail even when the saved preference is expanded", () => {
    localStorage.setItem("rf-sidebar-collapsed", "false");
    mount(COUNTER);
    expect(railCollapsed()).toBe(true);
    expect(railExpanded()).toBe(false);
  });

  it("outside register mode the saved preference rules, unchanged", () => {
    localStorage.setItem("rf-sidebar-collapsed", "false");
    mount("/orders");
    expect(railExpanded()).toBe(true);
    cleanup();
    localStorage.setItem("rf-sidebar-collapsed", "true");
    mount("/orders");
    expect(railCollapsed()).toBe(true);
  });

  it("peek expands and re-collapses the rail without ever writing rf-sidebar-collapsed", () => {
    localStorage.setItem("rf-sidebar-collapsed", "false");
    setItemKeys.length = 0;
    mount(COUNTER);
    fireEvent.click(screen.getByRole("button", { name: "Peek navigation" }));
    expect(railExpanded()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide navigation" }));
    expect(railCollapsed()).toBe(true);
    expect(setItemKeys).not.toContain("rf-sidebar-collapsed");
    expect(localStorage.getItem("rf-sidebar-collapsed")).toBe("false");
  });

  it("restores the saved sidebar state on leaving the counter, peeked or not", () => {
    localStorage.setItem("rf-sidebar-collapsed", "false");
    const view = mount(COUNTER);
    fireEvent.click(screen.getByRole("button", { name: "Peek navigation" }));
    view.go("/orders");
    expect(railExpanded()).toBe(true);
    expect(localStorage.getItem("rf-sidebar-collapsed")).toBe("false");
    view.go(COUNTER);
    expect(railCollapsed()).toBe(true); // a fresh visit never starts peeked
    cleanup();
    localStorage.setItem("rf-sidebar-collapsed", "true");
    const again = mount(COUNTER);
    again.go("/orders");
    expect(railCollapsed()).toBe(true);
  });

  it("keeps the whole nav reachable (collapsed, not removed)", () => {
    mount("/orders");
    const open = Array.from(aside().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    cleanup();
    mount(COUNTER);
    const reg = Array.from(aside().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    expect(reg).toEqual(expect.arrayContaining(open));
    expect(reg).toContain(COUNTER);
    expect(reg).toContain("/customers");
  });
});

describe("slim header", () => {
  it("has Exit counter as the first focusable control", () => {
    mount(COUNTER);
    const first = registerHeader().querySelector(FOCUSABLE);
    expect(first).toBe(screen.getByRole("button", { name: "Exit counter" }));
  });

  it("shows the clerk and the store name", () => {
    mount(COUNTER);
    expect(within(registerHeader()).getByText("ada.clerk")).toBeInTheDocument();
    expect(within(registerHeader()).getByText("Acme Wholesale")).toBeInTheDocument();
  });

  it("keeps a navigation-menu button for the sub-lg drawer", () => {
    mount(COUNTER);
    fireEvent.click(within(registerHeader()).getByLabelText("Open navigation menu"));
    expect(screen.getByTestId("sidebar-drawer-aside")).toBeInTheDocument();
  });
});

describe("Exit counter", () => {
  it("goes back to the last non-counter dashboard path", () => {
    const view = mount("/invoices");
    view.go(COUNTER);
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    expect(mockPush).toHaveBeenCalledWith("/invoices");
  });

  it("falls back to /dashboard when there is no previous path", () => {
    mount(COUNTER);
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("rejects an unsafe stored path and goes to /dashboard", () => {
    sessionStorage.setItem("rf-register-prev", "https://evil.example/x");
    mount(COUNTER);
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe("discard guard", () => {
  const withLines = () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
  };

  it("asks first when the cart has lines; Keep selling is the default and focused", async () => {
    withLines();
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep selling" })).toHaveFocus());
  });

  it("Escape keeps the cart", async () => {
    withLines();
    await screen.findByText("Discard this sale?");
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep selling" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Keep selling closes the dialog and stays on the counter", async () => {
    withLines();
    fireEvent.click(await screen.findByRole("button", { name: "Keep selling" }));
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Discard leaves the counter", async () => {
    withLines();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("does not ask when the cart is empty (and follows the live signal)", () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    act(() => setCounterCartHasLines(false));
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    expect(screen.queryByText("Discard this sale?")).toBeNull();
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("guards only the header Exit: nav links never open the dialog", () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    fireEvent.click(link);
    expect(screen.queryByText("Discard this sale?")).toBeNull();
  });
});

describe("non-register pages are unchanged", () => {
  it("keeps the full header and nav inventory on /orders", () => {
    mount("/orders");
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).queryByRole("button", { name: "Exit counter" })).toBeNull();
    expect(screen.queryByTestId("register-header")).toBeNull();
    const names = Array.from(header.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    expect(names).toEqual([
      "Open navigation menu",
      "Open command palette",
      "Open command palette",
      "Notifications",
      "Open user menu",
    ]);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Peek navigation" })).toBeNull();
  });
});

describe("device preference: Open the counter on this device", () => {
  const openMenu = () => {
    const trigger = screen.getByLabelText("Open user menu");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };
  const ITEM = { name: "Open the counter on this device" };

  it("is a menuitemcheckbox in the user menu that persists on and off", async () => {
    mount("/orders");
    openMenu();
    const item = await screen.findByRole("menuitemcheckbox", ITEM);
    expect(item).toHaveAttribute("aria-checked", "false");
    fireEvent.click(item);
    expect(localStorage.getItem("rf-open-counter")).toBe("true");
    openMenu();
    expect(await screen.findByRole("menuitemcheckbox", ITEM)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", ITEM));
    expect(localStorage.getItem("rf-open-counter")).toBe("false");
  });

  it("is hidden when storage is blocked", async () => {
    (Storage.prototype.setItem as jest.Mock).mockImplementation(() => {
      throw new Error("blocked");
    });
    mount("/orders");
    openMenu();
    await screen.findByRole("menuitem", { name: /Profile/i });
    expect(screen.queryByRole("menuitemcheckbox", ITEM)).toBeNull();
  });

  it("is hidden when the counter is off", async () => {
    mockGate = { showButton: false };
    mount("/orders");
    openMenu();
    await screen.findByRole("menuitem", { name: /Profile/i });
    expect(screen.queryByRole("menuitemcheckbox", ITEM)).toBeNull();
  });
});

describe("landing at /dashboard with the preference on", () => {
  beforeEach(() => localStorage.setItem("rf-open-counter", "true"));

  it("redirects to the counter once and says so once", async () => {
    const view = mount("/dashboard");
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(COUNTER));
    expect(await screen.findByText("Counter opened")).toBeInTheDocument();
    view.go(COUNTER);
    view.go("/dashboard"); // Exit's fallback lands here: it must NOT bounce back in
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Counter opened")).toHaveLength(1);
  });

  it("never redirects from any other path", () => {
    for (const p of ["/orders", "/dashboard/x", "/customers", COUNTER]) {
      mount(p);
      cleanup();
    }
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skips drivers and customers", () => {
    for (const role of ["DRIVER", "CUSTOMER"]) {
      mockRole = role;
      mount("/dashboard");
      cleanup();
    }
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skips impersonation sessions", () => {
    setImpersonation("tok", "acme", "admin");
    mount("/dashboard");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skips when the counter is off", () => {
    mockGate = { showButton: false };
    mount("/dashboard");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does nothing with the preference off", () => {
    localStorage.setItem("rf-open-counter", "false");
    mount("/dashboard");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
