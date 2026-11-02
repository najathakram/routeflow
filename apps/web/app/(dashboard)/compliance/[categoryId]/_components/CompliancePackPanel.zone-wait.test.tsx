import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CompliancePackPanel } from "./CompliancePackPanel";

/**
 * F14: the Purchases and Sales tabs get their date range from the business's zone. A disabled query has isLoading false,
 * so while /settings was loading or had failed the tab fell through to "No ... in this range." with both date boxes empty
 * and nothing ever fetched. Each tab must show the loading bar while the zone is unknown, the error with a Retry when the
 * zone read failed, and its empty text only once a range exists.
 */
let mockZone: { zone: string | undefined; isError: boolean } = { zone: undefined, isError: false };
let mockDay: string | undefined;
const mockRetry = jest.fn();
const mockPurchases = jest.fn();
const mockSales = jest.fn();

jest.mock("@/lib/tenant-timezone", () => ({
  useTenantTimeZoneQuery: () => ({ ...mockZone, retry: mockRetry }),
  useTenantTimeZone: () => mockZone.zone,
  useOnTenantToday: (apply: (day: string) => void) => {
    React.useEffect(() => {
      if (mockDay) apply(mockDay);
    }, []);
    return mockDay;
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useTobaccoInventory: () => ({ data: [], isLoading: false }),
  useTobaccoReports: () => ({ data: [], isLoading: false }),
  useTobaccoSettings: () => ({ data: undefined, isLoading: false }),
  useUpdateTobaccoSettings: () => ({ mutate: jest.fn(), isPending: false }),
  useGenerateTobaccoReport: () => ({ mutate: jest.fn(), isPending: false }),
  fetchTobaccoReportUrl: jest.fn(),
  useTobaccoPurchases: (...a: unknown[]) => mockPurchases(...a),
  useTobaccoSales: (...a: unknown[]) => mockSales(...a),
}));

const idle = { data: [], isLoading: false };

beforeEach(() => {
  mockZone = { zone: undefined, isError: false };
  mockDay = undefined;
  mockRetry.mockReset();
  mockPurchases.mockReset().mockReturnValue(idle);
  mockSales.mockReset().mockReturnValue(idle);
});

const TABS = [
  { tab: "Purchases", empty: /No tobacco purchases in this range/, hook: () => mockPurchases },
  { tab: "Sales", empty: /No tobacco sales in this range/, hook: () => mockSales },
] as const;

describe.each(TABS)("$tab tab waits for the business's zone (F14)", ({ tab, empty, hook }) => {
  async function open() {
    renderWithProviders(<CompliancePackPanel categoryId="tobacco" />);
    await userEvent.click(screen.getByRole("tab", { name: tab }));
  }

  it("shows the loading bar, not the empty text, while the zone is unknown", async () => {
    await open();
    expect(screen.getByTestId("range-loading")).toBeInTheDocument();
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    expect(hook().mock.calls.every((c) => c[1]?.enabled === false)).toBe(true);
  });

  it("shows the error with a Retry when the zone read failed, and Retry re-reads it", async () => {
    mockZone = { zone: undefined, isError: true };
    await open();
    expect(screen.getByTestId("range-zone-failed")).toHaveTextContent(/time zone/);
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the empty text once the range exists", async () => {
    mockZone = { zone: "America/Chicago", isError: false };
    mockDay = "2026-11-02";
    await open();
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(screen.queryByTestId("range-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("range-zone-failed")).not.toBeInTheDocument();
    expect(hook().mock.calls.at(-1)?.[0]).toEqual({ from: "2026-01-01", to: "2026-11-02" });
  });
});
