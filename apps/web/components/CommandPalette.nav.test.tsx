import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";
import type { SubscriptionView } from "@routeflow/types";
import { navLeaves, quickActions, quickActionHref } from "@/app/(dashboard)/_components/nav-index";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { navFor } from "@/test-utils/nav";
import { CommandPalette } from "./CommandPalette";

/**
 * UXG-R8 (C1): the palette is generated from the menu the layout built. One row per menu entry, no row for
 * a page the menu hides, Actions first on an empty query, and retired names stay findable.
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => ({ data: undefined }) }));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

beforeEach(() => {
  mockPush.mockClear();
  mockRole = "OPERATOR";
});
afterEach(cleanup);

const open = (nav: ReturnType<typeof navFor>) =>
  render(<CommandPalette open onClose={() => {}} nav={nav} />);

/** The section headings in the order shown, and the row labels under one heading. */
const headings = () =>
  Array.from(document.querySelectorAll("p.uppercase")).map((p) => p.textContent);
const rowsUnder = (heading: string): string[] => {
  const p = Array.from(document.querySelectorAll("p.uppercase")).find(
    (h) => h.textContent === heading,
  );
  return Array.from(p?.parentElement?.querySelectorAll("button p.truncate:first-child") ?? []).map(
    (r) => r.textContent ?? "",
  );
};
const allRows = () =>
  Array.from(document.querySelectorAll("button p.truncate:first-child")).map(
    (r) => r.textContent ?? "",
  );

describe("CommandPalette pages come from the menu (UXG-R8 T4, T5)", () => {
  it("T4: a LITE business (no plan flags) is not offered Reports, Analytics or Estimates", () => {
    open(navFor({ plan: { flags: [], resolved: true, failed: false } }));
    const rows = rowsUnder("palette.jumpTo");
    for (const gone of ["Reports", "Analytics", "Estimates", "Credit notes", "Suppliers"])
      expect(rows).not.toContain(gone);
    expect(rows).toContain("Invoices");
  });

  it("T5: a full operator gets one Jump to row per menu entry, in menu order, and no other", () => {
    const nav = navFor({
      canActAsDriver: true,
      counterEnabled: true,
      hasSalesAgents: true,
      regulatedSections: [{ id: "s1", name: "Acme tobacco" }],
      insightsAccess: true,
    });
    open(nav);
    const rows = rowsUnder("palette.jumpTo");
    // SA-1205: a menu entry an Action already opens (the counter) is not listed twice.
    const covered = new Set(
      quickActions(nav, { staff: true, readOnly: false }).map(quickActionHref),
    );
    expect(rows).toEqual(
      navLeaves(nav)
        .filter((l) => !covered.has(l.href))
        .map((l) => l.label),
    );
    for (const label of [
      "Shipments",
      "Payment requests",
      "Supplier statements",
      "Sales agents",
      "Commissions",
      "Acme tobacco",
    ])
      expect(rows).toContain(label);
  });

  it("B179: a delivery-only business (no recurring routes) still has Drivers and no Routes row", () => {
    open(navFor({ routesAccess: false }));
    const rows = rowsUnder("palette.jumpTo");
    expect(rows).toContain("Drivers");
    expect(rows).not.toContain("Routes");
  });

  it("the retired name Overview finds both pages that used to carry it", () => {
    open(navFor());
    fireEvent.change(screen.getByPlaceholderText("palette.placeholder"), {
      target: { value: "overview" },
    });
    expect(rowsUnder("palette.jumpTo")).toEqual(["Dispatch", "Finance overview"]);
  });

  it("a Jump to row opens its menu entry's page", () => {
    open(navFor({ counterEnabled: true }));
    fireEvent.click(screen.getByText("Shipments"));
    expect(mockPush).toHaveBeenCalledWith("/shipments");
  });

  it("no Jump to row is written by hand: CommandPalette.tsx pushes no page literal", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "CommandPalette.tsx"), "utf8");
    expect(src).not.toMatch(/router\.push\("\//);
  });
});

describe("CommandPalette order and names (UXG-R8 T6, T7)", () => {
  it("T6: an empty query shows Actions first, then Jump to", () => {
    open(navFor());
    expect(headings().slice(0, 2)).toEqual(["palette.actions", "palette.jumpTo"]);
  });

  it("a typed query keeps Jump to before Actions", () => {
    open(navFor());
    fireEvent.change(screen.getByPlaceholderText("palette.placeholder"), {
      target: { value: "o" },
    });
    expect(headings().slice(0, 2)).toEqual(["palette.jumpTo", "palette.actions"]);
  });

  it("T7: a retired name finds the page: 'order delivery' and 'trips' give exactly Deliveries", () => {
    const nav = navFor();
    const deliveries = navLeaves(nav).find((l) => l.href === "/deliveries")!;
    for (const q of ["order delivery", "trips"]) {
      cleanup();
      open(nav);
      fireEvent.change(screen.getByPlaceholderText("palette.placeholder"), {
        target: { value: q },
      });
      expect(allRows()).toEqual([deliveries.label]);
    }
  });

  it("aliases are never rows of their own", () => {
    open(navFor());
    expect(allRows()).not.toContain("Trips");
    expect(allRows()).not.toContain("Expenses");
  });
});

describe("CommandPalette by role (UXG-R8 T8)", () => {
  it("T8: a driver's rows are exactly the driver menu and there are no Actions", () => {
    mockRole = "DRIVER";
    const nav = navFor({ role: "DRIVER" });
    open(nav);
    expect(headings()).toEqual(["palette.jumpTo"]);
    expect(allRows()).toEqual(navLeaves(nav).map((l) => l.label));
    expect(allRows()).toContain("Today's route");
  });

  it("a customer's rows are exactly the customer menu, no Actions (REG-B1)", () => {
    mockRole = "CUSTOMER";
    const nav = navFor({ role: "CUSTOMER" });
    open(nav);
    expect(headings()).toEqual(["palette.jumpTo"]);
    expect(allRows()).toEqual(navLeaves(nav).map((l) => l.label));
  });
});

describe("CommandPalette empty Enter and duplicate rows (SA-1205 P1-P5)", () => {
  const input = () => screen.getByPlaceholderText("palette.placeholder");
  const openWith = (nav: ReturnType<typeof navFor>, onClose = jest.fn()) => {
    render(<CommandPalette open onClose={onClose} nav={nav} />);
    return onClose;
  };

  it("P1: empty query, Enter does nothing and the palette stays open", () => {
    const onClose = openWith(navFor());
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("P2: empty query, ArrowDown then Enter runs the first Action", () => {
    openWith(navFor());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/orders?action=new");
  });

  it("P3: typing 'dash' then Enter opens the Dashboard", () => {
    openWith(navFor());
    fireEvent.change(input(), { target: { value: "dash" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("P4: with a counter, 'counter' gives exactly the one Action row", () => {
    openWith(navFor({ counterEnabled: true }));
    fireEvent.change(input(), { target: { value: "counter" } });
    expect(allRows()).toEqual(["New counter sale"]);
  });

  const view = (status: string) =>
    ({ status, billingContactEmail: "dana@acme.test" }) as unknown as SubscriptionView;
  const clickable = () =>
    Array.from(document.querySelectorAll("button")).filter((b) => b.querySelector("p.truncate"));

  it.each([
    [
      "operator with a counter",
      "OPERATOR",
      { counterEnabled: true, insightsAccess: true },
      "ACTIVE",
    ],
    ["operator without one", "OPERATOR", {}, "ACTIVE"],
    ["driver", "DRIVER", {}, "ACTIVE"],
    ["buyer", "CUSTOMER", {}, "ACTIVE"],
    ["read-only operator with a counter", "OPERATOR", { counterEnabled: true }, "READ_ONLY"],
  ] as const)(
    "P5: %s: no two rows share a destination and every menu page is reachable",
    (_n, role, over, status) => {
      mockRole = role;
      const nav = navFor({ ...over, role });
      render(
        <ReadOnlyGateProvider view={view(status)}>
          <CommandPalette open onClose={() => {}} nav={nav} />
        </ReadOnlyGateProvider>,
      );
      const pushed: string[] = [];
      let blockedRows = 0;
      for (const r of clickable()) {
        mockPush.mockClear();
        fireEvent.click(r);
        pushed.push(...mockPush.mock.calls.map((c) => String(c[0])));
        if (r.getAttribute("aria-disabled") === "true") {
          blockedRows += 1;
          expect(mockPush).not.toHaveBeenCalled(); // a blocked row opens nothing
        }
      }
      expect(pushed.length).toBeGreaterThan(0);
      expect(new Set(pushed).size).toBe(pushed.length);
      // Every menu page is opened by some row that works (a blocked Action opens nothing, so it cannot cover one).
      expect(
        navLeaves(nav)
          .filter((l) => !pushed.includes(l.href))
          .map((l) => l.href),
      ).toEqual([]);
      expect(blockedRows > 0).toBe(status === "READ_ONLY");
    },
  );

  it("D2: in a read-only workspace the Counter menu row stays, and 'counter' finds a row that works", () => {
    render(
      <ReadOnlyGateProvider view={view("READ_ONLY")}>
        <CommandPalette open onClose={() => {}} nav={navFor({ counterEnabled: true })} />
      </ReadOnlyGateProvider>,
    );
    fireEvent.change(input(), { target: { value: "counter" } });
    expect(allRows()).toContain("Counter");
    fireEvent.click(screen.getByText("Counter").closest("button")!);
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("the menu's own label is a keyword of the Action that absorbed its row", () => {
    // A menu that calls the counter "Cashier desk": no word of it is in the Action's label or keywords.
    const rename = <T extends { href: string; label: string }>(c: T): T =>
      c.href === "/orders/counter-sale" ? { ...c, label: "Cashier desk" } : c;
    const nav = navFor({ counterEnabled: true }).map((e) =>
      e.kind === "group"
        ? { ...e, children: e.children.map(rename) }
        : e.kind === "leaf"
          ? rename(e)
          : e,
    );
    openWith(nav);
    fireEvent.change(input(), { target: { value: "cashier" } });
    expect(allRows()).toEqual(["New counter sale"]);
  });

  it("D1: a pointer resting over a row when the palette opens does not arm it (hover alone, then Enter)", () => {
    const onClose = openWith(navFor());
    fireEvent.mouseEnter(clickable()[0]!); // the browser fires this when the panel opens under a parked cursor
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("D1: a real pointer move over a row highlights it, and Enter then runs it", () => {
    openWith(navFor());
    fireEvent.mouseMove(clickable()[1]!);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("ArrowUp on an empty query never highlights a row: Enter after ArrowUp does nothing", () => {
    openWith(navFor());
    for (let n = 0; n < 3; n += 1) fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("ArrowDown twice then ArrowUp past the top lands on no row again", () => {
    openWith(navFor());
    for (let n = 0; n < 2; n += 1) fireEvent.keyDown(input(), { key: "ArrowDown" });
    for (let n = 0; n < 5; n += 1) fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Escape closes the palette and opens nothing", () => {
    const onClose = openWith(navFor());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
