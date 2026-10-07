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

const TITLES = [
  "Business & team",
  "Selling & catalog",
  "Orders & stock",
  "Notifications",
  "Compliance",
  "Integrations",
  "Billing",
];

beforeEach(() => {
  restrictions.mockReturnValue({ data: { enabled: true }, isLoading: false, isError: false });
});

const SECTION_IDS: Record<string, string> = {
  "Selling & catalog": "selling",
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

  it("lists Selling restrictions under both Selling & catalog and Compliance", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of ["Selling & catalog", "Compliance"]) {
      const link = within(section(t)).getByRole("link", { name: /selling restrictions/i });
      expect(link).toHaveAttribute("href", "/settings/restrictions");
    }
  });

  it("operators see Selling restrictions in both groups (read-only page)", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    for (const t of ["Selling & catalog", "Compliance"]) {
      // Compliance collapses to a single card for operators (other items are admin-only).
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
    expect(hrefs).toHaveLength(2);
  });

  it("search 'restrictions' finds it in both groups", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "restrictions" },
    });
    // Each result carries its group in a breadcrumb.
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(2);
    expect(screen.getByText("Selling & catalog › Selling restrictions")).toBeInTheDocument();
    expect(screen.getByText("Compliance › Selling restrictions")).toBeInTheDocument();
  });

  it("mounts the route defaults card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
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

  it("a query spanning two fields ('defaults service') now lists Route defaults and shows its card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "defaults service" },
    });
    expect(
      screen.queryAllByRole("link").some((l) => l.getAttribute("href") === "#route-defaults"),
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

function search(q: string) {
  fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: q } });
}
const linkTo = (href: string) =>
  screen.queryAllByRole("link").find((l) => l.getAttribute("href") === href);
const resultRow = (label: string) =>
  within(screen.getByRole("list", { name: "Search results" }))
    .getAllByRole("listitem")
    .find((li) => within(li).queryByText(label) !== null);

describe("SettingsHub search speaks the user's words (IA PR1)", () => {
  it("'low stock' finds the Low-stock digest (the hyphen no longer breaks it)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("low stock");
    const link = linkTo("/settings?tab=notifications#low-stock-digest");
    expect(link).toBeTruthy();
    expect(link).toHaveTextContent("Low-stock digest");
  });

  it("'stock' no longer lands on the 'Orders & stock' group: Route defaults and Batch import are not listed", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("stock");
    expect(linkTo("#route-defaults")).toBeUndefined();
    expect(linkTo("/settings/batch-import")).toBeUndefined();
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
    expect(linkTo("/settings?tab=notifications#low-stock-digest")).toBeTruthy();
    expect(screen.getByText("Reorder points")).toBeInTheDocument();
  });

  it("'carrier' shows the answer as plain text, not a link", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("carrier");
    const answer = screen.getByText(
      "You choose the carrier on each order when you mark it shipped.",
    );
    expect(answer.closest("a")).toBeNull();
    expect(screen.getByText("Shipping carrier")).toBeInTheDocument();
  });

  it.each([
    ["walk-in", "Counter sales", "Ring up walk-in customers from the Orders screen."],
    ["counter", "Counter sales", "Ring up walk-in customers from the Orders screen."],
    ["ship several", "Ship several orders at once", "choose Mark shipped."],
    ["last price", "Last price a customer paid", "New orders fill in the last price you gave"],
  ])("'%s' finds the answer row '%s'", (q, label, text) => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    search(q);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(text.replace(/[.]/g, "\\.")))).toBeInTheDocument();
  });

  it.each([true, false])(
    "'stripe' and 'tier' reach the cards below the hub (admin=%s)",
    (isAdmin) => {
      renderWithProviders(<SettingsHub isAdmin={isAdmin} />);
      search("stripe");
      expect(linkTo("/settings#card-payments")).toHaveTextContent("Card payments");
      search("tier");
      expect(linkTo("/settings#tier-names")).toHaveTextContent("Pricing tier names");
    },
  );

  it("two words from different fields match ('defaults service' lists Route defaults)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("defaults service");
    expect(linkTo("#route-defaults")).toBeTruthy();
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });

  it("'invoice terms' shows Payment terms with its breadcrumb", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("invoice terms");
    const row = resultRow("Payment terms");
    expect(row).toBeTruthy();
    expect(row).toHaveTextContent("Selling & catalog › Invoicing");
    expect(within(row!).getByRole("link")).toHaveAttribute(
      "href",
      "/settings?tab=invoicing#payment-terms",
    );
  });

  it("'restrictions' still lists exactly the two Selling restrictions links", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("restrictions");
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(2);
  });

  it("an operator searching 'regulated' finds nothing (admin-only screens stay hidden)", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    search("regulated");
    expect(linkTo("/settings?tab=regulated")).toBeUndefined();
    expect(screen.getByText(/No settings match “regulated”\./)).toBeInTheDocument();
  });

  it("an admin searching 'regulated' finds the Regulated sections", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("regulated");
    expect(linkTo("/settings?tab=regulated")).toBeTruthy();
  });

  it("no match: says so, offers the way out, and Clear Search restores the hub and the input focus", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("zzzzqq");
    expect(screen.getByText(/No settings match “zzzzqq”\./)).toBeInTheDocument();
    expect(screen.getByText("Try another word, or browse all settings.")).toBeInTheDocument();
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(screen.getByLabelText("Search settings")).toHaveValue("");
    expect(screen.getByLabelText("Search settings")).toHaveFocus();
    expect(screen.getAllByTestId(/^settings-group-/)).toHaveLength(7);
  });

  it("a query with no letters or digits is no search: the hub shows as usual", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("?");
    expect(screen.getAllByTestId(/^settings-group-/)).toHaveLength(7);
    expect(screen.queryByText(/No settings match/)).not.toBeInTheDocument();
  });

  it("results are one flat list with a breadcrumb row each, and the chips are hidden while searching", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("email");
    const list = screen.getByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(1);
    expect(screen.queryByText("Frequently used:")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^settings-group-/)).toHaveLength(0);
  });

  it("GUARD: with no query the hub is as it always was (7 groups, 4 chips, route defaults, My account)", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getAllByTestId(/^settings-group-/)).toHaveLength(7);
    expect(screen.getByText("Frequently used:")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link")
        .filter((l) => l.closest("div")?.textContent?.includes("Frequently used:")).length,
    ).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
    expect(linkTo("/settings?tab=account")).toHaveTextContent("My account");
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
  });

  it("My account is found by search and the footer is not shown twice", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    search("password");
    const hrefs = screen
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"))
      .filter((h) => h === "/settings?tab=account");
    expect(hrefs).toHaveLength(1);
    expect(linkTo("/settings?tab=account#password")).toBeTruthy();
  });
});

describe("SettingsHub readiness banner", () => {
  it("shows the banner with an admin link when the master switch is off", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByRole("status")).toHaveTextContent(/selling restrictions are off/i);
    expect(within(screen.getByRole("status")).getByRole("link")).toHaveAttribute(
      "href",
      "/settings/restrictions",
    );
  });

  it("shows text but no link to operators", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin={false} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/selling restrictions are off/i);
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
