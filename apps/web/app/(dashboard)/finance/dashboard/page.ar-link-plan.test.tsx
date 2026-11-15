import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinanceDashboardPage from "./page";

/**
 * UXG B8. Entry condition: the finance dashboard has loaded (`isLoading` false) with an `arAging`
 * block, as the endpoint answers on every plan. `/finance/reports` is plan-gated (`flag.reports`),
 * so on a plan without Reports neither AR card may lead there. Red on master: both linked on every plan.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/finance/dashboard",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

let reports = { enabled: true, resolved: true, failed: false };
jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: () => reports }));

const bucket = {
  total: 300,
  current: 100,
  days1_15: 50,
  days16_30: 50,
  days31_45: 60,
  days45plus: 40,
};
const month = { sales: 10, receipts: 5, due: 5 };
const finance = {
  arAging: bucket,
  monthlySales: { data: [], totalSales: 10, totalReceipts: 5, totalExpenses: 2 },
  topExpenses: [],
  summaryTable: {
    today: month,
    thisWeek: month,
    thisMonth: month,
    thisQuarter: month,
    thisYear: month,
  },
};
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({ data: finance, isLoading: false, refetch: jest.fn() }),
}));

const REPORT = "/finance/reports?report=ar-aging";
const hrefs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") as string);

beforeEach(() => {
  reports = { enabled: true, resolved: true, failed: false };
});

describe("Finance overview AR links follow the plan's Reports flag", () => {
  it("plan without Reports: neither the AR card nor the overdue tile links to the report", () => {
    reports = { enabled: false, resolved: true, failed: false };
    const { container } = renderWithProviders(<FinanceDashboardPage />);
    expect(hrefs(container)).not.toContain(REPORT);
    expect(screen.queryByRole("link", { name: /Aging report/ })).toBeNull();
    // The figure stays; only the navigation goes (the tile is a plain card, same content).
    const tile = screen.getByTestId("overdue-tile");
    expect(tile.tagName).toBe("DIV");
    expect(tile.textContent).toContain("Overdue (>30 days)");
    expect(tile.querySelector("svg.lucide-arrow-right")).toBeNull();
    expect(screen.getByText("total outstanding")).toBeTruthy();
  });
  it("Reports flag still loading: no report link either", () => {
    reports = { enabled: true, resolved: false, failed: false };
    const { container } = renderWithProviders(<FinanceDashboardPage />);
    expect(hrefs(container)).not.toContain(REPORT);
  });
  it("plan with Reports: Aging report and the overdue tile both link to the report", () => {
    const { container } = renderWithProviders(<FinanceDashboardPage />);
    expect(screen.getByRole("link", { name: /Aging report/ }).getAttribute("href")).toBe(REPORT);
    expect(hrefs(container).filter((h) => h === REPORT)).toHaveLength(2);
    expect(screen.queryByTestId("overdue-tile")).toBeNull();
  });
  it("Reports fetch failed: fails open, both links stay", () => {
    reports = { enabled: false, resolved: false, failed: true };
    const { container } = renderWithProviders(<FinanceDashboardPage />);
    expect(hrefs(container).filter((h) => h === REPORT)).toHaveLength(2);
  });
});
