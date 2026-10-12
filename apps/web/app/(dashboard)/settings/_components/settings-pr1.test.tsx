import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";

/**
 * Settings PR1a: the hub list, the Business card, trailing values and the "nothing lost" parity matrix (brief section 4: every link / anchor / tab key still resolves).
 */

let mockUser: { id: string; username: string; role: string } | null = null;
let mockPath = "/settings";
let mockQuery = "";
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
  mockFleet = true;
  mockCounter = true;
  mockBranding = { businessName: "Acme Wholesale Co.", logoUrl: null };
  seedApi();
  calls.length = 0;
  window.history.replaceState(null, "", "/settings");
});

const row = (id: string) => screen.getByTestId(`settings-row-${id}`);
const hrefs = () =>
  screen
    .getAllByRole("link")
    .map((l) => l.getAttribute("href"))
    .filter((h): h is string => !!h);

describe("hub list", () => {
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

  it("Pay is a 44px target", async () => {
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

const askedFulfilment = () => calls.filter((c) => c.url === "/settings/fulfilment").length;

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

  it("admin, every gate open: all 12 tab keys, 7 sub-routes, 6 anchors", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    await waitFor(() => expect(hrefs().some((h) => h.includes("fulfilment"))).toBe(true));
    const now = new Set(hrefs());
    for (const t of TABS)
      expect([...now].some((h) => h.startsWith(`/settings?tab=${t}`))).toBe(true);
    for (const s of SUBS) expect(now.has(s)).toBe(true);
    for (const a of ANCHORS) expect([...now].some((h) => h.endsWith(`#${a}`))).toBe(true);
    expect(now.has("/orders/counter-sale")).toBe(true);
  });

  it("operator: everything except regulated and product labels", async () => {
    mockUser = OPERATOR;
    renderWithProviders(<SettingsHub isAdmin={false} />);
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
  });

  it("fleet off hides Route defaults in the list and the search", async () => {
    mockFleet = false;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.queryByTestId("settings-row-route-defaults")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "depot" } });
    expect(
      screen.queryAllByRole("link").some((l) => l.getAttribute("href")?.includes("route-defaults")),
    ).toBe(false);
  });
});

describe("the fulfilment flag is read once, by the admin hub only", () => {
  const asked = () => calls.filter((c) => c.url === "/settings/fulfilment").length;

  it("admin: the bare hub asks once", async () => {
    renderWithProviders(<SettingsHub isAdmin />);
    await waitFor(() => expect(row("fulfillment")).toBeInTheDocument());
    expect(asked()).toBe(1);
  });

  it("operator: never, and the pane does not fetch the admin-only attention reads", async () => {
    mockUser = OPERATOR;
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await screen.findByTestId("business-card");
    expect(asked()).toBe(0);
    expect(calls.some((c) => c.url === "/settings/remittance")).toBe(false);
  });
});

describe("a malformed hash never throws", () => {
  it("the hub survives '#%E0'", async () => {
    window.history.replaceState(null, "", "/settings#%E0");
    expect(() => renderWithProviders(<SettingsHub isAdmin />)).not.toThrow();
    expect(await screen.findByTestId("business-card")).toBeInTheDocument();
  });
});
