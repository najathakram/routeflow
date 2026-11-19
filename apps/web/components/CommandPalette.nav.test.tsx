import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";
import { navLeaves } from "@/app/(dashboard)/_components/nav-index";
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
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => ({ showButton: true }) }));
jest.mock("@/components/insights/use-insights-access", () => ({ useInsightsAccess: () => true }));

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
    expect(rows).toEqual(navLeaves(nav).map((l) => l.label));
    for (const label of [
      "Shipments",
      "Payment requests",
      "Supplier statements",
      "Sales agents",
      "Commissions",
      "Acme tobacco",
      "Counter",
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
