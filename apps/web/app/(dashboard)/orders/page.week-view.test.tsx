import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { startOfTenantWeek } from "@/lib/tenant-week";
import OrdersPage from "./page";

// "Shipped this week" = Sunday 00:00 in the BUSINESS's timezone (not a rolling 7 UTC days). The list's
// week view must send the SAME instant the dashboard card does.

const calls: Array<{ params: Record<string, unknown>; enabled?: boolean }> = [];
let settings: { timezone?: string } = { timezone: "Asia/Tokyo" };
let settingsFails = false;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams("fulfillPath=SHIP&shipView=week"),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: (params: Record<string, unknown>, options?: { enabled?: boolean }) => {
    calls.push({ params, enabled: options?.enabled });
    return {
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    };
  },
  useUpdateOrderStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn(() =>
      settingsFails ? Promise.reject(new Error("403")) : Promise.resolve({ data: settings }),
    ),
  },
}));

describe("OrdersPage — shipView=week", () => {
  beforeEach(() => {
    calls.length = 0;
    settingsFails = false;
  });

  it("sends Sunday 00:00 in the tenant's zone, not a rolling 7 days", async () => {
    settings = { timezone: "Asia/Tokyo" };
    renderWithProviders(<OrdersPage />);
    await waitFor(() => expect(calls.some((c) => c.params.shippedFrom)).toBe(true));
    const sent = calls.filter((c) => c.params.shippedFrom).pop()!.params.shippedFrom as string;
    expect(sent).toBe(startOfTenantWeek(new Date(), "Asia/Tokyo").toISOString());
    expect(sent).toMatch(/T15:00:00\.000Z$/); // Sunday 00:00 JST
  });

  it("does not fetch an unfiltered list while the timezone is unknown", async () => {
    settings = {};
    renderWithProviders(<OrdersPage />);
    await screen.findByRole("heading", { name: /orders/i }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it("settings error: inline error + Retry, no week-view orders request; Retry success loads the week view", async () => {
    settings = { timezone: "Asia/Tokyo" };
    settingsFails = true;
    renderWithProviders(<OrdersPage />);
    expect(await screen.findByText("Couldn't load your time zone.")).toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.enabled === false && !c.params.shippedFrom)).toBe(true);

    settingsFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.some((c) => c.enabled !== false && c.params.shippedFrom)).toBe(true),
    );
    expect(screen.queryByText("Couldn't load your time zone.")).not.toBeInTheDocument();
  });
});
