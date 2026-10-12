import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";
import { SettingsRail } from "./SettingsRail";
import { SettingsShell } from "./SettingsShell";
import { StripeConnectCard } from "./StripeConnectCard";
import { EMAIL_CONNECTED_MAILBOX_ADDON, MailboxCard } from "./MailboxCard";
import { useHashScroll } from "./use-hash-scroll";

/**
 * Settings PR1: the hub list (below xl), the rail (xl and up), the Business card, trailing values, the
 * shell, and the "nothing lost" parity matrix (brief section 4: every link / anchor / tab key still resolves).
 */

let mockUser: { id: string; username: string; role: string } | null = null;
let mockPath = "/settings";
let mockQuery = "";
let mockDesktop = false;
let mockFleet = true;
let mockCounter = false;
let mockBranding: { businessName: string; logoUrl: string | null } | null = null;
const api = new Map<string, unknown>();
const calls: { url: string; cfg?: unknown }[] = [];

jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(mockQuery),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: mockUser }),
}));
jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({ branding: mockBranding, slug: "acme", isLoading: false, refresh: jest.fn() }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: mockFleet, loading: false }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({ showButton: mockCounter, capability: {} }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./BuyerOversellCard", () => ({ BuyerOversellCard: () => <div>oversell-card</div> }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string, cfg?: unknown) => {
      calls.push({ url, cfg });
      const hit = api.get(url);
      if (hit === undefined || hit instanceof Error) return Promise.reject(hit ?? new Error(url));
      return Promise.resolve({ data: hit });
    },
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const ADMIN = { id: "u1", username: "dana", role: "TENANT_ADMIN" };
const OPERATOR = { id: "u2", username: "sam", role: "OPERATOR" };

const SUB_ACTIVE = {
  planKey: "growth",
  planName: "Growth",
  status: "ACTIVE",
  billingState: "current",
  addons: [],
};
const SUB_DUE = {
  ...SUB_ACTIVE,
  billingState: "due",
  openInvoiceAmount: 149,
  payNowAmount: 149,
  outstandingTotal: 149,
  payNowUrl: "https://pay.example/inv_1",
};

function seedApi(over: Record<string, unknown> = {}) {
  api.clear();
  const base: Record<string, unknown> = {
    "/settings": { timezone: "America/Chicago" },
    "/settings/invoice": { defaultTerms: "Net 30" },
    "/import/numbering": [{ docType: "INVOICE", prefix: "INV-", configured: true }],
    "/settings/inventory": { buyerOversell: "backorder", buyerBackorderVisibility: "show" },
    "/settings/route": { serviceTimeMinutes: 10, defaultStartTime: "08:00" },
    "/settings/stripe-connect": { configured: true, connected: true },
    "/settings/fulfilment": { selfServe: true },
    "/users": { data: [], meta: { total: 4 } },
    "/billing/subscription": SUB_ACTIVE,
    "/settings/remittance": { payToName: "Acme Wholesale" },
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) api.set(k, v);
}

beforeEach(() => {
  mockUser = ADMIN;
  mockPath = "/settings";
  mockQuery = "";
  mockDesktop = false;
  mockFleet = true;
  mockCounter = true;
  mockBranding = { businessName: "Acme Wholesale Co.", logoUrl: null };
  seedApi();
  calls.length = 0;
  window.history.replaceState(null, "", "/settings");
  window.matchMedia = ((q: string) => ({
    matches: mockDesktop && q.includes("1280"),
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

const row = (id: string) => screen.getByTestId(`settings-row-${id}`);
const hrefs = () =>
  screen
    .getAllByRole("link")
    .map((l) => l.getAttribute("href"))
    .filter((h): h is string => !!h);

describe("hub list (below xl)", () => {
  it("shows the 7 groups in order, with the old testids kept and no Billing group", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const ids = screen.getAllByTestId(/^settings-group-/).map((g) => g.dataset.testid);
    expect(ids).toEqual(
      [
        "fulfilment",
        "business",
        "payments",
        "selling",
        "notifications",
        "compliance",
        "integrations",
      ].map((k) => `settings-group-${k}`),
    );
    expect(screen.queryByTestId("settings-group-billing")).not.toBeInTheDocument();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      "How you sell",
      "Business & team",
      "Invoicing & payments",
      "Selling & pricing",
      "Notifications",
      "Compliance",
      "Integrations & import",
    ]);
  });

  it("order is search, Business card, chips, groups", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const search = screen.getByLabelText("Search settings");
    const card = screen.getByTestId("business-card");
    const chips = screen.getByText("Frequently used:");
    const group = screen.getByTestId("settings-group-fulfilment");
    const before = (a: Node, b: Node) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(before(search, card)).toBeTruthy();
    expect(before(card, chips)).toBeTruthy();
    expect(before(chips, group)).toBeTruthy();
  });

  it("rows are 52px with a pressed fade that honours reduced motion", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(row("invoicing").className).toMatch(/min-h-\[52px\]/);
    expect(row("invoicing").className).toMatch(/\[transition-duration:120ms\]/);
    expect(row("invoicing").className).toMatch(/ring-inset/);
    expect(row("invoicing").className).toMatch(/motion-reduce:transition-none/);
    expect(row("invoicing").className).toMatch(/focus-visible:ring-2/);
  });

  it("each row carries its helper line", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(
      within(row("invoicing")).getByText("Numbering, terms & default notes"),
    ).toBeInTheDocument();
  });

  it("shows trailing values from data the app already loads", async () => {
    mockCounter = true;
    renderWithProviders(<SettingsHub isAdmin />);
    const expected: [string, string][] = [
      ["business-profile", "America/Chicago"],
      ["invoicing", "INV- · Net 30"],
      ["out-of-stock-ordering", "Allowed"],
      ["route-defaults", "10 min · 08:00"],
      ["card-payments", "Connected"],
      ["counter-sales", "On"],
      ["user-management", "4 people"],
    ];
    for (const [id, text] of expected) {
      await waitFor(() => expect(within(row(id)).getByText(text)).toBeInTheDocument());
    }
    // "N people" counts active users only (deactivated people are not on the team).
    expect(calls.find((c) => c.url === "/users")?.cfg).toEqual({ params: { status: "ACTIVE" } });
  });

  it.each(["restocked", "customers see"])(
    "a search for '%s' shows the Out-of-stock card its result points at (no dead link)",
    (word) => {
      renderWithProviders(<SettingsHub isAdmin />);
      expect(screen.getByText("oversell-card")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: word } });
      const list = screen.getByRole("list", { name: "Search results" });
      expect(within(list).getAllByRole("link")[0]).toHaveAttribute(
        "href",
        "#out-of-stock-ordering",
      );
      expect(screen.getByText("oversell-card")).toBeInTheDocument();
      expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
    },
  );

  it("a failed or missing query shows nothing (never 'undefined', no spinner)", async () => {
    seedApi({
      "/settings": new Error("500"),
      "/settings/invoice": {},
      "/import/numbering": {},
      "/settings/inventory": new Error("500"),
      "/users": { data: [], meta: {} },
    });
    renderWithProviders(<SettingsHub isAdmin />);
    await screen.findByTestId("settings-row-invoicing");
    await waitFor(() =>
      expect(within(row("card-payments")).getByText("Connected")).toBeInTheDocument(),
    );
    for (const id of [
      "business-profile",
      "invoicing",
      "out-of-stock-ordering",
      "user-management",
    ]) {
      expect(row(id).textContent).not.toMatch(/undefined|NaN|null/);
      expect(within(row(id)).queryByTestId("row-value")).not.toBeInTheDocument();
    }
  });

  it("Fulfillment and Counter sales rows follow the self-serve flag exactly", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    await waitFor(() =>
      expect(row("fulfillment")).toHaveAttribute(
        "href",
        "/settings?tab=fulfilment#delivery-method",
      ),
    );
    expect(row("counter-sales")).toHaveAttribute("href", "/settings?tab=fulfilment#counter-sales");
  });

  it.each([{ selfServe: false }, new Error("503")])(
    "flag off or unknown hides them (%p)",
    async (resp) => {
      seedApi({ "/settings/fulfilment": resp });
      renderWithProviders(<SettingsHub isAdmin />);
      await screen.findByTestId("settings-row-invoicing");
      await waitFor(() =>
        expect(within(row("card-payments")).getByText("Connected")).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("settings-row-fulfillment")).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-row-counter-sales")).not.toBeInTheDocument();
    },
  );

  it("Counter quick keys and Day close need the counter capability", () => {
    mockCounter = false;
    const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.queryByTestId("settings-row-counter-quick-keys")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-row-day-close")).not.toBeInTheDocument();
    unmount();
    mockCounter = true;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(row("counter-quick-keys")).toHaveAttribute("href", "/orders/counter-sale");
    expect(row("day-close")).toHaveAttribute("href", "/orders/counter-sale");
  });

  it("Enter in the search box opens the first result", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const box = screen.getByLabelText("Search settings");
    fireEvent.change(box, { target: { value: "time zone" } });
    const first = within(screen.getByRole("list", { name: "Search results" })).getAllByRole(
      "link",
    )[0];
    const clicked = jest.fn((e: Event) => e.preventDefault());
    first.addEventListener("click", clicked);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(first).toHaveAttribute("href", "/settings?tab=profile#settings-timezone");
  });

  it("'/' focuses the search box unless focus is already in a field", () => {
    renderWithProviders(
      <>
        <SettingsHub isAdmin />
        <input aria-label="other" />
      </>,
    );
    const box = screen.getByLabelText("Search settings");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(box).toHaveFocus();
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(other).toHaveFocus();
  });

  it("search results show the matched word bold and a 'group › page' breadcrumb", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "counter" } });
    const list = screen.getByRole("list", { name: "Search results" });
    expect(
      within(list).getAllByText("Counter", { selector: "strong, b, mark" }).length,
    ).toBeGreaterThan(0);
    expect(within(list).getAllByText("How you sell › Counter quick keys").length).toBeGreaterThan(
      0,
    );
  });

  it("the empty state keeps its copy and suggests words", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "zzzzqq" } });
    expect(screen.getByText("No settings match “zzzzqq”.")).toBeInTheDocument();
    expect(screen.getByText("Try: counter, carrier, backorder, time zone")).toBeInTheDocument();
  });

  it("admins still see Needs attention in the list (as PR1a), not only in the xl pane", async () => {
    seedApi({
      "/settings/remittance": {},
      "/settings/stripe-connect": { configured: true, connected: false },
    });
    renderWithProviders(<SettingsHub isAdmin />);
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/settings?tab=remittance", "/settings#card-payments"]);
  });

  it("operators never get the regulated or product-label rows", () => {
    mockUser = OPERATOR;
    renderWithProviders(<SettingsHub isAdmin={false} />);
    expect(screen.queryByTestId("settings-row-regulated-sections")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-row-product-labels")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });
});

describe("Business card", () => {
  it("the whole card opens Plan & billing and shows name, plan and status", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const card = screen.getByTestId("business-card");
    expect(card).toHaveAttribute("href", "/settings/billing");
    expect(within(card).getByText("Acme Wholesale Co.")).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByText("Growth")).toBeInTheDocument());
    expect(within(card).getByText("Active")).toBeInTheDocument();
  });

  it("no logo: an initial tile; no status yet: still a working link", () => {
    seedApi({ "/billing/subscription": new Error("500") });
    renderWithProviders(<SettingsHub isAdmin />);
    const card = screen.getByTestId("business-card");
    expect(within(card).getByText("A")).toBeInTheDocument();
    expect(card).toHaveAttribute("href", "/settings/billing");
    expect(card.textContent).not.toMatch(/undefined/);
  });

  it("Pay $X appears only when payment is due, only for an admin", async () => {
    seedApi({ "/billing/subscription": SUB_DUE });
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
    const pay = await screen.findByRole("button", { name: "Pay $149.00" });
    expect(pay.closest("a")).toBeNull();
    fireEvent.click(pay);
    expect(open).toHaveBeenCalledWith("https://pay.example/inv_1", "_blank", "noopener,noreferrer");
    expect(
      within(screen.getByTestId("business-card")).getByText("Payment due"),
    ).toBeInTheDocument();
    unmount();

    mockUser = OPERATOR;
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await screen.findByText("Payment due");
    expect(screen.queryByRole("button", { name: /^Pay/ })).not.toBeInTheDocument();
    open.mockRestore();
  });

  it("Pay is a 44px target below the rail breakpoint", async () => {
    seedApi({ "/billing/subscription": SUB_DUE });
    renderWithProviders(<SettingsHub isAdmin />);
    expect((await screen.findByRole("button", { name: "Pay $149.00" })).className).toMatch(
      /min-h-11/,
    );
  });

  it("no Pay button while active", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    await screen.findByText("Active");
    expect(screen.queryByRole("button", { name: /^Pay/ })).not.toBeInTheDocument();
  });
});

describe("hub pane (xl and up)", () => {
  beforeEach(() => {
    mockDesktop = true;
  });

  it("shows the large Business card and does NOT repeat the group rows (the rail owns them)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByTestId("business-card")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^settings-group-/)).toHaveLength(0);
    expect(screen.queryByLabelText("Search settings")).not.toBeInTheDocument();
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
    expect(screen.getByText("oversell-card")).toBeInTheDocument();
  });

  it("lists what needs attention for an admin, each with its link", async () => {
    seedApi({
      "/billing/subscription": SUB_DUE,
      "/settings/remittance": {},
      "/settings/stripe-connect": { configured: true, connected: false },
    });
    renderWithProviders(<SettingsHub isAdmin />);
    const list = await screen.findByRole("list", { name: "Needs attention" });
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(3));
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/settings/billing", "/settings?tab=remittance", "/settings#card-payments"]);
  });

  it("has no Needs attention list when nothing needs it, and none for operators", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    await screen.findByText("Active");
    expect(screen.queryByRole("list", { name: "Needs attention" })).not.toBeInTheDocument();
  });

  it("operators see no Needs attention list", async () => {
    mockUser = OPERATOR;
    seedApi({ "/billing/subscription": SUB_DUE, "/settings/remittance": {} });
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await screen.findByText("Payment due");
    expect(screen.queryByRole("list", { name: "Needs attention" })).not.toBeInTheDocument();
  });
});

describe("rail (xl and up)", () => {
  beforeEach(() => {
    mockDesktop = true;
  });

  it("is a 'Settings' navigation landmark with search first and the groups after", () => {
    renderWithProviders(<SettingsRail isAdmin />);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByLabelText("Search settings")).toBeInTheDocument();
    expect(within(nav).getByTestId("business-card-rail")).toBeInTheDocument();
    expect(within(nav).getAllByTestId(/^settings-group-/)).toHaveLength(7);
  });

  it("the first focusable in the rail skips to the content, which is a focus target", () => {
    renderWithProviders(
      <SettingsShell>
        <div>page-body</div>
      </SettingsShell>,
    );
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const skip = within(nav).getAllByRole("link")[0];
    expect(skip).toHaveTextContent("Skip to settings content");
    expect(skip).toHaveAttribute("href", "#settings-content");
    const target = document.getElementById("settings-content");
    expect(target).toContainElement(screen.getByText("page-body"));
    expect(target).toHaveAttribute("tabindex", "-1");
  });

  it("rail rows and the Business card use an inset focus ring (the aside clips an outer one)", () => {
    renderWithProviders(<SettingsRail isAdmin />);
    expect(row("invoicing").className).toMatch(/focus-visible:ring-inset/);
    expect(screen.getByTestId("business-card-rail").className).toMatch(/focus-visible:ring-inset/);
  });

  it("rows are compact: label only, no helper line, no 'Admin' tags", () => {
    mockUser = OPERATOR;
    renderWithProviders(<SettingsRail isAdmin={false} />);
    expect(row("invoicing").className).toMatch(/min-h-9|min-h-\[36px\]/);
    expect(
      within(row("invoicing")).queryByText("Numbering, terms & default notes"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });

  it("marks the open ?tab= row with aria-current=page", () => {
    mockQuery = "tab=invoicing";
    renderWithProviders(<SettingsRail isAdmin />);
    expect(row("invoicing")).toHaveAttribute("aria-current", "page");
    expect(row("costing")).not.toHaveAttribute("aria-current");
    expect(
      screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
  });

  it("highlights on sub-routes too: /settings/billing lights the Business card", () => {
    mockPath = "/settings/billing";
    renderWithProviders(<SettingsRail isAdmin />);
    const card = screen.getByTestId("business-card-rail");
    expect(card).toHaveAttribute("aria-current", "page");
    // "current" is a tint like the rail rows; the ring is for keyboard focus only
    expect(card.className).toMatch(/bg-\[var\(--accent-soft\)\]/);
    expect(card.className).not.toMatch(/(^|\s)ring-2/);
  });

  it("in-page anchors become absolute so they work from any settings page", () => {
    mockPath = "/settings/import";
    renderWithProviders(<SettingsRail isAdmin />);
    expect(row("route-defaults")).toHaveAttribute("href", "/settings#route-defaults");
    expect(row("out-of-stock-ordering")).toHaveAttribute("href", "/settings#out-of-stock-ordering");
    expect(row("import-data")).toHaveAttribute("aria-current", "page");
  });

  it("typing replaces the groups with flat results and hides the chips", () => {
    renderWithProviders(<SettingsRail isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "counter" } });
    expect(screen.queryAllByTestId(/^settings-group-/)).toHaveLength(0);
    expect(screen.queryByText("Frequently used:")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Search results" })).toBeInTheDocument();
  });

  it("Fulfillment and Counter sales are told apart by the hash", async () => {
    mockQuery = "tab=fulfilment";
    window.history.replaceState(null, "", "/settings?tab=fulfilment#counter-sales");
    renderWithProviders(<SettingsRail isAdmin />);
    await waitFor(() => expect(row("counter-sales")).toHaveAttribute("aria-current", "page"));
    expect(row("fulfillment")).not.toHaveAttribute("aria-current");
  });
});

describe("shell", () => {
  it.each(["CUSTOMER", "DRIVER"])("%s gets no rail, only the page", (role) => {
    mockUser = { id: "x", username: "x", role };
    mockDesktop = true;
    renderWithProviders(
      <SettingsShell>
        <div>page-body</div>
      </SettingsShell>,
    );
    expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByText("page-body")).toBeInTheDocument();
  });

  it("the rail and the pane carry distinct Business card testids", () => {
    mockDesktop = true;
    renderWithProviders(
      <SettingsShell>
        <SettingsHub isAdmin />
      </SettingsShell>,
    );
    expect(screen.getAllByTestId("business-card-rail")).toHaveLength(1);
    expect(screen.getAllByTestId("business-card")).toHaveLength(1);
  });

  it("staff at xl get the rail beside the page; below xl the page alone", () => {
    mockDesktop = true;
    const { unmount } = renderWithProviders(
      <SettingsShell>
        <div>page-body</div>
      </SettingsShell>,
    );
    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("page-body")).toBeInTheDocument();
    unmount();
    mockDesktop = false;
    renderWithProviders(
      <SettingsShell>
        <div>page-body</div>
      </SettingsShell>,
    );
    expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByText("page-body")).toBeInTheDocument();
  });
});

const askedFulfilment = () => calls.filter((c) => c.url === "/settings/fulfilment").length;

describe("the fulfilment flag is read once, by the admin rail or hub, only where a row needs it", () => {
  const shell = (child: React.ReactNode = <div>page-body</div>) => (
    <SettingsShell>{child}</SettingsShell>
  );

  it("admin, rail on a sub-route: asked exactly once", async () => {
    mockDesktop = true;
    mockPath = "/settings/billing";
    renderWithProviders(shell());
    await waitFor(() => expect(row("fulfillment")).toBeInTheDocument());
    expect(askedFulfilment()).toBe(1);
  });

  it("admin, rail + bare hub together: still once (one shared read)", async () => {
    mockDesktop = true;
    renderWithProviders(shell(<SettingsHub isAdmin />));
    await waitFor(() => expect(row("fulfillment")).toBeInTheDocument());
    expect(askedFulfilment()).toBe(1);
  });

  it("admin, below the rail breakpoint on a sub-route: never (nothing shows a row)", async () => {
    mockDesktop = false;
    mockPath = "/settings/billing";
    renderWithProviders(shell());
    await screen.findByText("page-body");
    expect(askedFulfilment()).toBe(0);
  });

  it("admin, below the rail breakpoint on the bare hub: once", async () => {
    mockDesktop = false;
    renderWithProviders(shell(<SettingsHub isAdmin />));
    await waitFor(() => expect(row("fulfillment")).toBeInTheDocument());
    expect(askedFulfilment()).toBe(1);
  });

  it("an operator: never", async () => {
    mockUser = OPERATOR;
    mockDesktop = true;
    renderWithProviders(shell(<SettingsHub isAdmin={false} />));
    await screen.findAllByTestId("business-card");
    expect(askedFulfilment()).toBe(0);
  });

  it("a customer (no rail, no hub): never", async () => {
    mockUser = { id: "c", username: "c", role: "CUSTOMER" };
    mockDesktop = true;
    renderWithProviders(shell());
    await screen.findByText("page-body");
    expect(askedFulfilment()).toBe(0);
  });

  it("an operator's pane does not fetch the admin-only attention reads", async () => {
    mockUser = OPERATOR;
    mockDesktop = true;
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await screen.findByTestId("business-card");
    expect(calls.some((c) => c.url === "/settings/remittance")).toBe(false);
  });
});

describe("a malformed hash never throws", () => {
  it("the shell and the hub survive '#%E0'", async () => {
    window.history.replaceState(null, "", "/settings/billing#%E0");
    mockDesktop = true;
    expect(() =>
      renderWithProviders(
        <SettingsShell>
          <SettingsHub isAdmin />
        </SettingsShell>,
      ),
    ).not.toThrow();
    expect((await screen.findAllByTestId("business-card")).length).toBeGreaterThan(0);
  });
});

describe("return flows still work under the shell (brief section 4)", () => {
  it("?stripe=connected banner on the bare hub", async () => {
    mockQuery = "stripe=connected&charges=enabled";
    mockDesktop = true;
    renderWithProviders(
      <SettingsShell>
        <StripeConnectCard />
      </SettingsShell>,
    );
    expect(
      await screen.findByText("Stripe connected — you can now accept card payments."),
    ).toBeInTheDocument();
  });

  it("?tab=email&mailbox_cancelled=google toasts and strips the flag", async () => {
    window.history.replaceState({}, "", "/settings?tab=email&mailbox_cancelled=google");
    mockQuery = "tab=email";
    mockDesktop = true;
    seedApi({
      "/tenants/me/addons": { addons: [EMAIL_CONNECTED_MAILBOX_ADDON] },
      "/settings/email/mailbox": {
        configured: true,
        googleConfigured: true,
        microsoftConfigured: true,
        connected: false,
      },
    });
    renderWithProviders(
      <SettingsShell>
        <MailboxCard />
      </SettingsShell>,
    );
    expect(await screen.findByText("Gmail connection cancelled")).toBeInTheDocument();
    expect(window.location.search).toBe("?tab=email");
  });

  it("billing ?checkout= is left alone by the shell (it has no web reader to break)", async () => {
    window.history.replaceState({}, "", "/settings/billing?checkout=success");
    mockPath = "/settings/billing";
    mockDesktop = true;
    renderWithProviders(
      <SettingsShell>
        <div>billing-body</div>
      </SettingsShell>,
    );
    expect(await screen.findByText("billing-body")).toBeInTheDocument();
    expect(window.location.search).toBe("?checkout=success");
  });
});

describe("hash scroll on any settings screen", () => {
  function Probe() {
    useHashScroll("k");
    return null;
  }

  it("scrolls to the hash target once it mounts (client-rendered tab bodies)", async () => {
    jest.useFakeTimers();
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/settings?tab=fulfilment#delivery-method");
    renderWithProviders(<Probe />);
    expect(scroll).not.toHaveBeenCalled();
    const el = document.createElement("div");
    el.id = "delivery-method";
    document.body.appendChild(el);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(el);
    el.remove();
    jest.useRealTimers();
  });

  it("gives up quietly when the id never appears, and does nothing without a hash", async () => {
    jest.useFakeTimers();
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/settings?tab=invoicing");
    renderWithProviders(<Probe />);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(scroll).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe("nothing lost: every link, anchor and tab key still resolves (brief section 4)", () => {
  const TABS = [
    "profile",
    "users",
    "invoicing",
    "remittance",
    "costing",
    "notifications",
    "email",
    "integrations",
    "gohighlevel",
    "account",
    "regulated",
    "fulfilment",
  ];
  const SUBS = [
    "/settings/billing",
    "/settings/import",
    "/settings/migration",
    "/settings/batch-import",
    "/settings/restrictions",
    "/settings/restrictions/rules",
    "/settings/product-categories",
  ];
  const ANCHORS = [
    "route-defaults",
    "out-of-stock-ordering",
    "delivery-method",
    "counter-sales",
    "card-payments",
    "tier-names",
  ];

  function reachable(rail: boolean) {
    mockDesktop = rail;
    const view = rail
      ? renderWithProviders(<SettingsRail isAdmin />)
      : renderWithProviders(<SettingsHub isAdmin />);
    return { view, all: new Set(hrefs()) };
  }

  it.each([false, true])(
    "admin, every gate open (rail=%s): all 12 tab keys, 7 sub-routes, 6 anchors",
    async (rail) => {
      const { all } = reachable(rail);
      await waitFor(() => expect(all.size).toBeGreaterThan(0));
      await waitFor(() => expect(hrefs().some((h) => h.includes("fulfilment"))).toBe(true));
      const now = new Set(hrefs());
      for (const t of TABS)
        expect([...now].some((h) => h.startsWith(`/settings?tab=${t}`))).toBe(true);
      for (const s of SUBS) expect(now.has(s)).toBe(true);
      for (const a of ANCHORS) expect([...now].some((h) => h.endsWith(`#${a}`))).toBe(true);
      expect(now.has("/orders/counter-sale")).toBe(true);
    },
  );

  it.each([false, true])(
    "operator (rail=%s): everything except regulated and product labels",
    async (rail) => {
      mockUser = OPERATOR;
      mockDesktop = rail;
      rail
        ? renderWithProviders(<SettingsRail isAdmin={false} />)
        : renderWithProviders(<SettingsHub isAdmin={false} />);
      await waitFor(() => expect(hrefs()).toContain("/orders/counter-sale"));
      const now = hrefs();
      // Fulfillment / Counter sales rows come from the admin-only flag read: an operator never gets them.
      expect(now.some((h) => h.includes("tab=fulfilment"))).toBe(false);
      expect(calls.some((c) => c.url === "/settings/fulfilment")).toBe(false);
      expect(now.some((h) => h.startsWith("/settings?tab=regulated"))).toBe(false);
      expect(now).not.toContain("/settings/product-categories");
      expect(now).toContain("/settings/restrictions");
      expect(now).toContain("/settings/restrictions/rules");
      expect(now).toContain("/settings?tab=account");
    },
  );

  it("fleet off hides Route defaults in the list, the rail and the search", async () => {
    mockFleet = false;
    const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.queryByTestId("settings-row-route-defaults")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "depot" } });
    expect(
      screen.queryAllByRole("link").some((l) => l.getAttribute("href")?.includes("route-defaults")),
    ).toBe(false);
    unmount();
    mockDesktop = true;
    renderWithProviders(<SettingsRail isAdmin />);
    expect(screen.queryByTestId("settings-row-route-defaults")).not.toBeInTheDocument();
  });
});
