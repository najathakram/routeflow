import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { OFF_HUB_SCREENS, SETTINGS_REGISTRY, type SettingRow } from "@routeflow/types";
import { SettingsHub } from "./SettingsHub";

const restrictions = jest.fn();
let unitsEnabled = true;
jest.mock("@/lib/api/product-units", () => ({ useUnitsEnabled: () => unitsEnabled }));
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
  "Business & team",
  "Selling & catalog",
  "Orders & stock",
  "Notifications",
  "Compliance",
  "Integrations",
  "Billing",
];

beforeEach(() => {
  unitsEnabled = true;
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
    // A group left with one item renders as a single card titled by the group.
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(2);
    expect(screen.getByText("Selling & catalog")).toBeInTheDocument();
    expect(screen.getByText("Compliance")).toBeInTheDocument();
  });

  describe("Units (U-1)", () => {
    const unitsLinks = () =>
      screen.getAllByRole("link").filter((l) => l.getAttribute("href") === "/settings/units");

    it("is the LAST item of Selling & catalog and appears exactly once", () => {
      renderWithProviders(<SettingsHub isAdmin />);
      const hrefs = within(section("Selling & catalog"))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"));
      expect(hrefs[hrefs.length - 1]).toBe("/settings/units");
      expect(unitsLinks()).toHaveLength(1);
      expect(within(unitsLinks()[0]).getByText("Units")).toBeInTheDocument();
    });

    it("ships DARK: without flag.units_v1 the tile is gone, and search cannot find it either", () => {
      unitsEnabled = false;
      const noUnitsLinks = () =>
        screen.queryAllByRole("link").filter((l) => l.getAttribute("href") === "/settings/units");
      renderWithProviders(<SettingsHub isAdmin />);
      expect(noUnitsLinks()).toHaveLength(0);
      const hrefs = within(section("Selling & catalog"))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"));
      expect(hrefs).not.toContain("/settings/units");
      fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "unit" } });
      expect(noUnitsLinks()).toHaveLength(0);
    });

    it("operators see it too (all staff may edit units)", () => {
      renderWithProviders(<SettingsHub isAdmin={false} />);
      expect(unitsLinks()).toHaveLength(1);
    });

    it("nothing else in Selling & catalog moved: the earlier links keep their order", () => {
      renderWithProviders(<SettingsHub isAdmin />);
      const hrefs = within(section("Selling & catalog"))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"));
      expect(hrefs.slice(0, -1)).toEqual([
        "/settings?tab=invoicing",
        "/settings?tab=costing",
        "/settings?tab=remittance",
        "/settings/restrictions",
        "/settings/import",
        "/settings/migration",
      ]);
    });

    it.each(["unit", "case", "bottle", "pieces per box", "pack"])("search %j finds it", (q) => {
      renderWithProviders(<SettingsHub isAdmin />);
      fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: q } });
      expect(unitsLinks()).toHaveLength(1);
    });
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

  it("lists Out-of-stock ordering under Orders & stock and mounts its card at the anchor", () => {
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

  it.each(["speed & depot", "service time, start time", "orders & stock"])(
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

  it("a query spanning two fields ('defaults service') lists nothing, so the card stays hidden", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "defaults service" },
    });
    expect(
      screen.queryAllByRole("link").some((l) => l.getAttribute("href") === "#route-defaults"),
    ).toBe(false);
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
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
