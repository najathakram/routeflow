import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { navLeaves } from "@/app/(dashboard)/_components/nav-index";
import { navFor } from "@/test-utils/nav";
import { CommandPalette } from "./CommandPalette";

/**
 * UXG-R8 M1: every page name the palette offered before the menu became its one source still finds that
 * page when typed. The list is fixed data: the 22 "Navigate" labels of CommandPalette.tsx at master
 * 28051c24d3 (git show 28051c24d3:apps/web/components/CommandPalette.tsx, lines 110-261), each with its page.
 */
const MASTER_LABELS: ReadonlyArray<readonly [label: string, href: string]> = [
  ["Dashboard", "/dashboard"],
  ["All Orders", "/orders"],
  ["Returns", "/returns"],
  ["Deliveries", "/deliveries"],
  ["Routes", "/routes"],
  ["Drivers", "/drivers"],
  ["Customers", "/customers"],
  ["Products", "/products"],
  ["Promotions", "/promotions"],
  ["Inventory", "/inventory"],
  ["Purchase orders", "/purchase-orders"],
  ["Suppliers", "/suppliers"],
  ["Invoices", "/invoices"],
  ["Estimates", "/estimates"],
  ["Credit notes", "/credit-notes"],
  ["Payments", "/finance/payments"],
  ["Supplier bills", "/vendor-bills"],
  ["Finance Overview", "/finance/dashboard"],
  ["Reports", "/finance/reports"],
  ["Analytics", "/analytics"],
  ["Product insights", "/insights"],
  ["Settings", "/settings"],
];

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => ({ data: undefined }) }));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

beforeEach(() => mockPush.mockClear());
afterEach(cleanup);

const CONTEXTS = [
  ["OPERATOR", { insightsAccess: true, counterEnabled: true }],
  ["OPERATOR", { canActAsDriver: true, insightsAccess: true }],
  ["SUPER_ADMIN", { insightsAccess: true }],
  ["CUSTOMER", {}],
  ["DRIVER", {}],
] as const;

/** Types `query`, clicks every row found, and returns the pages those rows opened. */
function pagesFound(role: string, over: Parameters<typeof navFor>[0], query: string): string[] {
  mockRole = role;
  const { unmount } = render(
    <CommandPalette open onClose={() => {}} nav={navFor({ ...over, role: role as never })} />,
  );
  fireEvent.change(screen.getByPlaceholderText("palette.placeholder"), {
    target: { value: query },
  });
  const rows = Array.from(document.querySelectorAll("button")).filter((b) =>
    b.querySelector("p.truncate"),
  );
  const opened: string[] = [];
  for (const row of rows) {
    mockPush.mockClear();
    fireEvent.click(row);
    for (const call of mockPush.mock.calls) opened.push(String(call[0])); // the exact href: an Action to "/orders?action=new" is not "/orders"
  }
  unmount();
  return opened;
}

describe("M1: every name the palette offered on master still finds its page", () => {
  it.each(CONTEXTS)("%s %#: each master label, typed, opens its page", (role, over) => {
    const held = new Set(navLeaves(navFor({ ...over, role })).map((l) => l.href));
    const missing: string[] = [];
    for (const [label, href] of MASTER_LABELS) {
      if (!held.has(href)) continue;
      if (!pagesFound(role, over, label).includes(href)) missing.push(`${label} -> ${href}`);
    }
    expect({ role, missing }).toEqual({ role, missing: [] });
  });

  it("the pinned list is the 22 master labels", () => {
    expect(MASTER_LABELS).toHaveLength(22);
  });
});
