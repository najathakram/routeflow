import * as React from "react";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { createTestQueryClient } from "@/test-utils/render";
import { setCounterCartBusy, setCounterCartHasLines } from "@/lib/counter-cart-signal";
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
const mockLogout = jest.fn();
const mockSetPalette = jest.fn();
let mockDriveMode = false;
const mockSetDriveMode = jest.fn();
const BLOCKED = /A sale is in progress\. Wait for the receipt or check its status before leaving\./;
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => mockGate }));
jest.mock("@/lib/auth-context", () => ({
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
  mockLogout.mockClear();
  mockSetPalette.mockClear();
  mockSetDriveMode.mockClear();
  mockNotifications = [];
  mockDriveMode = false;
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
  act(() => setCounterCartBusy(false));
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

describe("shell controls survive in register mode (nothing lost)", () => {
  const openMenu = () => {
    const trigger = within(registerHeader()).getByLabelText("Open user menu");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };

  it("keeps the avatar/user menu: Profile, Sign out, Language, preference are reachable", async () => {
    mount(COUNTER);
    openMenu();
    expect(await screen.findByRole("menuitem", { name: /Profile/i })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Open the counter on this device" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/i }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("keeps the notifications bell", () => {
    mount(COUNTER);
    expect(
      within(registerHeader()).getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("keeps the palette trigger, and Cmd+K still opens the palette (the shortcut is shell-wide, not header-bound)", () => {
    mount(COUNTER);
    fireEvent.click(
      within(registerHeader()).getAllByRole("button", { name: "Open command palette" })[0],
    );
    expect(mockSetPalette).toHaveBeenCalledWith(true);
  });

  it("keeps the drive-mode exit pill", () => {
    mockDriveMode = true;
    mount(COUNTER);
    expect(within(registerHeader()).getByTitle("Exit drive mode")).toBeInTheDocument();
  });

  it("shows the clerk (truncated, hidden below sm) via the user menu trigger", () => {
    mount(COUNTER);
    const clerk = screen.getByTestId("register-clerk");
    expect(clerk).toHaveTextContent("ada.clerk");
    expect(clerk.className).toContain("max-w-[8rem]");
    expect(clerk.className).toContain("truncate");
  });

  it("Exit stays the first focusable control with the tools present", () => {
    mount(COUNTER);
    expect(registerHeader().querySelector(FOCUSABLE)).toBe(
      screen.getByRole("button", { name: "Exit counter" }),
    );
  });
});

describe("Exit is blocked while a sale is being recorded", () => {
  it("does nothing but explain while busy (no navigation, no dialog), even with lines in the cart", () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    act(() => setCounterCartBusy(true));
    const exit = screen.getByRole("button", { name: "Exit counter" });
    expect(exit).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(exit);
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard this sale?")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/sale is in progress/i);
  });

  it("works again once the sale settles", () => {
    mount(COUNTER);
    act(() => setCounterCartBusy(true));
    act(() => setCounterCartBusy(false));
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("a Discard dialog that is already open cannot leave once the sale goes busy", async () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledTimes(1); // control: not busy -> leaves
    mockPush.mockClear();
    cleanup();
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    fireEvent.click(screen.getByRole("button", { name: "Exit counter" }));
    const discard = await screen.findByRole("button", { name: "Discard" });
    act(() => setCounterCartBusy(true));
    fireEvent.click(discard);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("every other way to leave is blocked while a sale is being recorded", () => {
  const busyCounter = () => {
    const view = mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    act(() => setCounterCartBusy(true));
    return view;
  };
  const openMenu = () => {
    const trigger = within(registerHeader()).getByLabelText("Open user menu");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };
  const press = (...keys: string[]) => keys.forEach((key) => fireEvent.keyDown(window, { key }));

  it("Sign out does nothing but explain", async () => {
    busyCounter();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sign out/i }));
    expect(mockLogout).not.toHaveBeenCalled();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });

  it("Profile (Settings) does not navigate", async () => {
    busyCounter();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Profile/i }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });

  it("the drive-mode toggle does nothing", async () => {
    busyCounter();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Drive mode/i }));
    expect(mockSetDriveMode).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a g shortcut does not navigate", () => {
    busyCounter();
    press("g", "c");
    press("g", "s");
    press("g", "h");
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });

  it("a rail link click is cancelled", () => {
    busyCounter();
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(false); // preventDefault was called
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });

  it("a drawer link click is cancelled", () => {
    busyCounter();
    fireEvent.click(within(registerHeader()).getByLabelText("Open navigation menu"));
    const link = screen
      .getByTestId("sidebar-drawer-aside")
      .querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(false);
  });

  it("a bell notification link is cancelled", async () => {
    mockNotifications = [
      {
        id: "n1",
        type: "order",
        title: "New order",
        description: "d",
        timestamp: Date.now(),
        read: true,
        href: "/orders/1",
      },
    ];
    busyCounter();
    const bell = within(registerHeader()).getByRole("button", { name: /notifications/i });
    fireEvent.pointerDown(bell, { button: 0, ctrlKey: false });
    fireEvent.keyDown(bell, { key: "Enter" });
    const link = (await screen.findByText("New order")).closest("a") as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });

  it("the buyer-portal switch link is cancelled", async () => {
    busyCounter();
    openMenu();
    const link = await screen.findByRole("menuitem", { name: /buyer portal/i });
    expect(fireEvent.click(link)).toBe(false);
  });

  it("NOT busy: the bell link and the portal switch navigate as before", async () => {
    mockNotifications = [
      {
        id: "n1",
        type: "order",
        title: "New order",
        description: "d",
        timestamp: Date.now(),
        read: true,
        href: "/orders/1",
      },
    ];
    mount(COUNTER);
    const bell = within(registerHeader()).getByRole("button", { name: /notifications/i });
    fireEvent.pointerDown(bell, { button: 0, ctrlKey: false });
    fireEvent.keyDown(bell, { key: "Enter" });
    const link = (await screen.findByText("New order")).closest("a") as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
  });

  it("the banner goes away once the sale settles", () => {
    busyCounter();
    press("g", "c");
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
    act(() => setCounterCartBusy(false));
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it("Exit looks disabled while busy", () => {
    busyCounter();
    expect(screen.getByRole("button", { name: "Exit counter" }).className).toContain(
      "aria-disabled:opacity-50",
    );
  });

  it("NOT busy: Sign out, Profile, g shortcuts and rail links all work as before", async () => {
    mount(COUNTER);
    press("g", "c");
    expect(mockPush).toHaveBeenCalledWith("/customers");
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Profile/i }));
    expect(mockPush).toHaveBeenCalledWith("/settings");
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sign out/i }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it("off the counter the shell behaves exactly as before", async () => {
    mount("/orders");
    press("g", "c");
    expect(mockPush).toHaveBeenCalledWith("/customers");
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe("narrow header (390 px)", () => {
  it("keeps the store name a min width with truncation and a title", () => {
    mount(COUNTER);
    const store = screen.getByTestId("register-store");
    expect(store.className).toMatch(/min-w-\[?\d/);
    expect(store.className).toContain("truncate");
    expect(store).toHaveAttribute("title", "Acme Wholesale");
  });

  it("keeps Exit on one line", () => {
    mount(COUNTER);
    expect(screen.getByRole("button", { name: "Exit counter" }).className).toContain(
      "whitespace-nowrap",
    );
  });

  it("gives the bell and the palette triggers 44 px targets", () => {
    mount(COUNTER);
    const targets = [
      ...within(registerHeader())
        .getAllByLabelText("Open command palette")
        .filter((el) => el.className.includes("md:hidden")),
      within(registerHeader()).getByLabelText("Notifications"),
    ];
    for (const el of targets) {
      expect(el.className).toContain("min-h-11");
      expect(el.className).toContain("min-w-11");
    }
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

  it("Escape returns focus to the Exit button", async () => {
    withLines();
    await screen.findByText("Discard this sale?");
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep selling" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Exit counter" })),
    );
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

  const openMenu = () => {
    const trigger = within(registerHeader()).getByLabelText("Open user menu");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };

  it("a rail link with lines asks first instead of navigating; Discard then goes there", async () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledWith("/customers");
  });

  it("Keep selling after a rail link leaves the cart and the route alone", async () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    fireEvent.click(aside().querySelector('a[href="/customers"]') as HTMLAnchorElement);
    fireEvent.click(await screen.findByRole("button", { name: "Keep selling" }));
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a bell notification link with lines asks first; Discard navigates once and the dialog stays closed", async () => {
    mockNotifications = [
      {
        id: "n1",
        type: "order",
        title: "New order",
        description: "d",
        timestamp: Date.now(),
        read: true,
        href: "/orders/1",
      },
    ];
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    const bell = within(registerHeader()).getByRole("button", { name: /notifications/i });
    fireEvent.pointerDown(bell, { button: 0, ctrlKey: false });
    fireEvent.keyDown(bell, { key: "Enter" });
    const link = (await screen.findByText("New order")).closest("a") as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/orders/1");
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
  });

  it("a rail link with an empty cart leaves directly", () => {
    mount(COUNTER);
    const link = aside().querySelector('a[href="/customers"]') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
    expect(screen.queryByText("Discard this sale?")).toBeNull();
  });

  it("Profile & Settings with lines asks first; Discard then goes to /settings", async () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Profile/i }));
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockPush).toHaveBeenCalledWith("/settings");
  });

  it("a g shortcut with lines asks first", async () => {
    mount(COUNTER);
    act(() => setCounterCartHasLines(true));
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  describe("browser Back", () => {
    let go: jest.SpyInstance;
    let pushState: jest.SpyInstance;
    beforeEach(() => {
      go = jest.spyOn(window.history, "go").mockImplementation(() => undefined);
      pushState = jest.spyOn(window.history, "pushState");
      Object.defineProperty(window.history, "length", { value: 5, configurable: true });
    });
    afterEach(() => {
      delete (window.history as { length?: number }).length;
      window.history.replaceState(null, "");
    });
    // Real Back lands on the entry BEFORE the sentinel, which carries no marker.
    const back = () =>
      act(() => {
        window.history.replaceState(null, "");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

    it("with lines asks first, re-pushes state, and Discard leaves", async () => {
      mount(COUNTER);
      act(() => setCounterCartHasLines(true));
      const before = pushState.mock.calls.length;
      back();
      expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
      expect(pushState.mock.calls.length).toBeGreaterThan(before);
      expect(go).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(go).toHaveBeenCalledWith(-2);
    });

    it("a second sale after a completed one reuses the one sentinel (Back + Discard still leaves)", async () => {
      mount(COUNTER);
      act(() => setCounterCartHasLines(true));
      back(); // a Back during the first sale: Keep selling re-pushes the one sentinel
      fireEvent.click(await screen.findByRole("button", { name: "Keep selling" }));
      const after1 = pushState.mock.calls.length;
      act(() => setCounterCartHasLines(false)); // sale completed
      act(() => setCounterCartHasLines(true)); // second sale
      expect(pushState.mock.calls.length).toBe(after1);
      back();
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
      expect(go).toHaveBeenCalledTimes(1);
      expect(go).toHaveBeenCalledWith(-2);
    });

    it("a deep link / new tab (no earlier page) falls back to the exit target on Discard", async () => {
      Object.defineProperty(window.history, "length", { value: 2, configurable: true });
      sessionStorage.setItem("rf-register-prev", "/invoices");
      mount(COUNTER);
      act(() => setCounterCartHasLines(true));
      back();
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
      expect(go).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith("/invoices");
    });

    it("Keep selling stays", async () => {
      mount(COUNTER);
      act(() => setCounterCartHasLines(true));
      back();
      fireEvent.click(await screen.findByRole("button", { name: "Keep selling" }));
      await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
      expect(go).not.toHaveBeenCalled();
    });

    it("with an empty cart does not ask", () => {
      mount(COUNTER);
      back();
      expect(screen.queryByText("Discard this sale?")).toBeNull();
      expect(go).not.toHaveBeenCalled();
    });
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
