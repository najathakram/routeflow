import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { OFF_HUB_SCREENS, SETTINGS_REGISTRY, type SettingRow } from "@routeflow/types";
import { SettingsHub } from "./SettingsHub";

const restrictions = jest.fn();
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => restrictions(),
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./BuyerOversellCard", () => ({
  BuyerOversellCard: ({ canEdit }: { canEdit: boolean }) => (
    <div>{`oversell-card-${canEdit ? "edit" : "read-only"}`}</div>
  ),
}));

const TITLES = [
  "How you sell",
  "Business & team",
  "Invoicing & payments",
  "Selling & pricing",
  "Notifications",
  "Compliance",
  "Integrations & import",
];

beforeEach(() => {
  restrictions.mockReturnValue({ data: { enabled: true }, isLoading: false, isError: false });
});

const SECTION_IDS: Record<string, string> = {
  "Selling & pricing": "selling",
  Compliance: "compliance",
};

function section(title: string) {
  return screen.getByTestId(`settings-group-${SECTION_IDS[title]}`);
}

describe("SettingsHub regroup", () => {
  it("shows the task groups for an admin", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of TITLES) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
    expect(screen.queryByText("Data & import")).not.toBeInTheDocument();
  });

  it("hides admin-only items from operators", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    expect(screen.queryByText("Regulated sections")).not.toBeInTheDocument();
    expect(screen.queryByText("Product labels")).not.toBeInTheDocument();
    expect(screen.getAllByText("Invoicing").length).toBeGreaterThan(0);
  });

  it("lists Selling restrictions under both Selling & pricing and Compliance", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of ["Selling & pricing", "Compliance"]) {
      const link = within(section(t)).getByRole("link", { name: /selling restrictions/i });
      expect(link).toHaveAttribute("href", "/settings/restrictions");
    }
  });

  it("(C h) links the rules page as Portal limits & rules from both groups", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of ["Selling & pricing", "Compliance"]) {
      const link = within(section(t)).getByRole("link", { name: /portal limits & rules/i });
      expect(link).toHaveAttribute("href", "/settings/restrictions/rules");
    }
  });

  it("operators see Selling restrictions in both groups (read-only page)", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    for (const t of ["Selling & pricing", "Compliance"]) {
      const hrefs = within(section(t))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"));
      expect(hrefs).toContain("/settings/restrictions");
    }
  });

  it("operators find it by search", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "restrictions" },
    });
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(1); // OK-2: one answer per destination
  });

  it("search 'receipt' finds the Business profile screen that holds the receipt footer", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "receipt" } });
    const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/settings?tab=profile");
    const row = SETTINGS_REGISTRY.find((r) => r.key === "settings.receiptFooter");
    expect(row).toMatchObject({
      key: "settings.receiptFooter",
      status: "live",
      screen: "/settings?tab=profile",
    });
  });

  it("search 'restrictions' finds it once (it lives in two groups; OK-2)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "restrictions" },
    });
    // A group left with one item renders as a single card titled by the group.
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(1); // OK-2: one answer per destination
    expect(screen.getByText("Selling & pricing › Selling restrictions")).toBeInTheDocument();
    expect(screen.queryByText("Compliance › Selling restrictions")).toBeNull();
  });

  describe("a page loaded with a card's hash scrolls to that card", () => {
    const scroll = jest.fn();
    beforeEach(() => {
      scroll.mockClear();
      Element.prototype.scrollIntoView = scroll;
    });
    afterEach(() => {
      window.history.replaceState(null, "", window.location.pathname);
    });

    it("#out-of-stock-ordering lands on the Out-of-stock ordering card", () => {
      window.history.replaceState(null, "", "#out-of-stock-ordering");
      renderWithProviders(<SettingsHub isAdmin />);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.instances[0]).toBe(document.getElementById("out-of-stock-ordering"));
    });

    it("#route-defaults lands on its card the same way", () => {
      window.history.replaceState(null, "", "#route-defaults");
      renderWithProviders(<SettingsHub isAdmin />);
      expect(scroll.mock.instances[0]).toBe(document.getElementById("route-defaults"));
    });

    it("no hash, or a hash that names nothing here, scrolls nothing", () => {
      renderWithProviders(<SettingsHub isAdmin />);
      window.history.replaceState(null, "", "#no-such-card");
      renderWithProviders(<SettingsHub isAdmin />);
      expect(scroll).not.toHaveBeenCalled();
    });
  });

  it("mounts the route defaults card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });

  it("lists Out-of-stock ordering under How you sell and mounts its card at the anchor", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const link = screen
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === "#out-of-stock-ordering");
    expect(link).toBeDefined();
    expect(within(link as HTMLElement).getByText("Out-of-stock ordering")).toBeInTheDocument();
    expect(screen.getByText("oversell-card-edit")).toBeInTheDocument();
    expect(document.getElementById("out-of-stock-ordering")).not.toBeNull();
  });

  it("an operator sees the card too, read-only", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    expect(screen.getByText("oversell-card-read-only")).toBeInTheDocument();
  });

  it("a search that lists the Out-of-stock ordering result also shows its card; a miss hides it", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const search = screen.getByLabelText("Search settings");
    fireEvent.change(search, { target: { value: "out of stock" } });
    expect(screen.getByText("oversell-card-edit")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz no such setting" } });
    expect(screen.queryByText("oversell-card-edit")).not.toBeInTheDocument();
  });

  it.each(["speed & depot", "service time, start time"])(
    "a search that lists the Route defaults result ('%s') also shows its card",
    (q) => {
      renderWithProviders(<SettingsHub isAdmin />);
      fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: q } });
      const link = screen
        .getAllByRole("link")
        .find((l) => l.getAttribute("href") === "#route-defaults");
      expect(link).toBeTruthy();
      expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
    },
  );

  it("a query spanning two fields ('defaults service') lists Route defaults and shows its card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "defaults service" },
    });
    expect(
      screen.getAllByRole("link").some((l) => l.getAttribute("href") === "#route-defaults"),
    ).toBe(true);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });

  it("hides the route defaults card when the search matches nothing", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "zzzzqq" } });
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
  });

  it("search 'depot' -> click the result -> the route defaults card is still rendered", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "depot" } });
    const link = screen
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === "#route-defaults");
    expect(link).toBeTruthy();
    fireEvent.click(link!);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
    expect(document.getElementById("route-defaults")).toContainElement(
      screen.getByText("route-defaults-card"),
    );
  });
});

describe("SettingsHub search speaks the user's words", () => {
  const search = (q: string) =>
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: q } });
  const results = () => screen.getByRole("list", { name: "Search results" });
  // A result row's accessible name is "label, effect, breadcrumb": match on the label.
  const hrefOf = (label: string) =>
    within(results())
      .getAllByRole("link")
      .find((l) => l.textContent?.startsWith(label))
      ?.getAttribute("href");

  it("1: 'low stock' finds the Low-stock digest card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("low stock");
    expect(hrefOf("Low-stock digest")).toBe("/settings?tab=notifications#low-stock-digest");
  });

  it("2: 'stock' lists Out-of-stock ordering, not Route defaults or Batch invoice import", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("stock");
    expect(
      within(results()).getByRole("link", { name: /^Out-of-\s*stock ordering/ }),
    ).toBeInTheDocument();
    expect(within(results()).queryByText("Route defaults")).not.toBeInTheDocument();
    expect(within(results()).queryByText("Batch invoice import")).not.toBeInTheDocument();
  });

  it("3: 'carrier' shows the answer as plain text, not a link", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("carrier");
    const answer = within(results()).getByText(
      "You choose the carrier on each order when you mark it shipped.",
    );
    expect(answer.closest("a")).toBeNull();
    expect(within(results()).queryAllByRole("link")).toHaveLength(0);
  });

  it.each([true, false])("4: stripe and tier find their cards (admin=%s)", (isAdmin) => {
    renderWithProviders(<SettingsHub isAdmin={isAdmin} />);
    search("stripe");
    expect(hrefOf("Card payments")).toBe("/settings#card-payments");
    search("tier");
    expect(hrefOf("Pricing tier names")).toBe("/settings#tier-names");
  });

  it("5: 'defaults service' lists Route defaults and mounts its card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("defaults service");
    expect(hrefOf("Route defaults")).toBe("#route-defaults");
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });

  it("6: 'invoice terms' lists Payment terms under Invoicing & payments > Invoicing", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("invoice terms");
    const row = within(results()).getByRole("link", { name: /Payment terms/ });
    expect(within(row).getByText("Invoicing & payments › Invoicing")).toBeInTheDocument();
  });

  it("7: 'restrictions' gives exactly one link to the restrictions page (OK-2)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("restrictions");
    const hrefs = within(results())
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(1); // OK-2: one answer per destination
  });

  it("8: an operator searching 'regulated' gets no link and the no-results text", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    search("regulated");
    expect(screen.getByText("No settings match “regulated”.")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("link").some((l) => l.getAttribute("href")?.includes("regulated")),
    ).toBe(false);
  });

  it("9: a miss says so, and Clear Search restores the hub and focuses the input", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("zzzzqq");
    expect(screen.getByText("No settings match “zzzzqq”.")).toBeInTheDocument();
    expect(screen.getByText("Try another word, or browse all settings.")).toBeInTheDocument();
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    const input = screen.getByLabelText("Search settings") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
    expect(screen.getAllByTestId(/^settings-group-/)).toHaveLength(7);
  });

  it("10: 'walk-in' finds the counter-sales answer", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("walk-in");
    expect(within(results()).getByText(/Ring up walk-in customers/)).toBeInTheDocument();
  });

  it("11: an empty query renders the hub exactly as before", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getAllByTestId(/^settings-group-/)).toHaveLength(7);
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
    for (const c of ["Invoicing", "User management", "Import", "Notifications"]) {
      expect(screen.getAllByRole("link", { name: c }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Frequently used:")).toBeInTheDocument();
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /My account/ })).toHaveAttribute(
      "href",
      "/settings?tab=account",
    );
  });
});

describe("SettingsHub readiness banner", () => {
  it("shows the banner with an admin link when the master switch is off", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /staff orders and invoices aren.t checked/i,
    );
    expect(within(screen.getByRole("status")).getByRole("link")).toHaveAttribute(
      "href",
      "/settings/restrictions",
    );
  });

  it("shows text but no link to operators", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin={false} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/staff orders and invoices aren.t checked/i);
    expect(within(banner).queryByRole("link")).not.toBeInTheDocument();
  });

  it("can be dismissed", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("no banner when enabled, loading, or errored", () => {
    for (const r of [
      { data: { enabled: true }, isLoading: false, isError: false },
      { data: undefined, isLoading: true, isError: false },
      { data: undefined, isLoading: false, isError: true },
    ]) {
      restrictions.mockReturnValue(r);
      const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("settings registry — every configurable setting has a screen (WS5)", () => {
  /** Screens that cannot be opened from the hub: missing from the hub and not declared off-hub. */
  function orphanScreens(
    rows: SettingRow[],
    hubHrefs: Set<string>,
    hasAnchor: (id: string) => boolean,
  ) {
    return rows
      .filter((r) => r.screen)
      .filter((r) => {
        const s = r.screen!;
        if (s in OFF_HUB_SCREENS) return false;
        if (s.startsWith("#")) return !hasAnchor(s.slice(1));
        return !hubHrefs.has(s);
      })
      .map((r) => `${r.key} -> ${r.screen}`);
  }

  function hubHrefs(): Set<string> {
    return new Set(
      screen
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"))
        .filter((h): h is string => !!h),
    );
  }

  it("every registry screen is reachable from the hub (or declared off-hub)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(
      orphanScreens(SETTINGS_REGISTRY, hubHrefs(), (id) => !!document.getElementById(id)),
    ).toEqual([]);
  });

  it("a row pointing at a screen nobody can open is reported", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const planted: SettingRow = {
      key: "planted.setting",
      home: "systemConfig",
      kind: "config",
      status: "live",
      screen: "/settings?tab=does-not-exist",
    };
    expect(orphanScreens([planted], hubHrefs(), (id) => !!document.getElementById(id))).toEqual([
      "planted.setting -> /settings?tab=does-not-exist",
    ]);
  });

  it("an in-hub anchor that is not mounted is reported", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const planted: SettingRow = {
      key: "planted.anchor",
      home: "systemConfig",
      kind: "config",
      status: "live",
      screen: "#nope",
    };
    expect(
      orphanScreens([planted], hubHrefs(), (id) => !!document.getElementById(id)),
    ).toHaveLength(1);
  });

  it("operators reach every non-admin-only hub screen in the registry", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    const missing = orphanScreens(
      SETTINGS_REGISTRY.filter((r) => !r.adminOnly),
      hubHrefs(),
      (id) => !!document.getElementById(id),
    );
    expect(missing).toEqual([]);
  });
});

describe("apple-ux U1: page cards under the hub follow the search", () => {
  const loose = [
    { id: "card-payments", node: <p>Stripe card body</p> },
    { id: "tier-names", node: <p>Tier names body</p> },
  ];
  const type = (q: string) =>
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: q } });

  it("no query: every loose card shows, each at its own anchor", () => {
    renderWithProviders(<SettingsHub isAdmin looseCards={loose} />);
    expect(screen.getByText("Stripe card body").closest("#card-payments")).not.toBeNull();
    expect(screen.getByText("Tier names body").closest("#tier-names")).not.toBeNull();
  });

  it("a query hides the cards it does not match, and keeps the one it does", () => {
    renderWithProviders(<SettingsHub isAdmin looseCards={loose} />);
    type("state");
    expect(screen.queryByText("Stripe card body")).toBeNull();
    expect(screen.queryByText("Tier names body")).toBeNull();
    type("stripe");
    expect(screen.getByText("Stripe card body")).toBeInTheDocument();
    expect(screen.queryByText("Tier names body")).toBeNull();
  });
});

describe("apple-ux U1: the search survives Back, and only Back (SA M2)", () => {
  afterEach(() => window.history.replaceState(null, ""));

  it("back/forward to the hub (its history entry carries the query) restores it", () => {
    const first = renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "plan" } });
    expect(window.history.state?.rfSettingsQuery).toBe("plan"); // stored on this entry
    first.unmount();
    // Back lands on the same history entry, so its state comes back with it
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByLabelText("Search settings")).toHaveValue("plan");
  });

  it("a fresh visit (sidebar, cmd-K, a back link: a NEW history entry) starts empty", () => {
    window.history.replaceState({ rfSettingsQuery: "plan" }, "");
    window.history.pushState({}, "", "/settings"); // a new entry without the key
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByLabelText("Search settings")).toHaveValue("");
  });

  it("other history state is kept when the query is stored", () => {
    window.history.replaceState({ __keep: 1 }, "");
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "tax" } });
    expect(window.history.state).toMatchObject({ __keep: 1, rfSettingsQuery: "tax" });
  });
});
