/**
 * REG-B123 — Developer Mode silently overrode the per-tenant delivery feature
 * toggles: `useDeliveryAccess`/`useRoutesAccess` used to OR the feature addon
 * with `useDeveloperMode().enabled`, so any tenant with `developer_mode` on
 * (which included every internal/demo tenant) saw the routes/dispatch surface
 * regardless of whether `order_delivery`/`recurring_routes` were actually
 * purchased. Owner decision 2026-08-28 (fixed in #491, 28cb0a25): the
 * composition helpers read the feature addon ALONE.
 *
 * Pinned behaviourally through the real hooks + a real QueryClient — a
 * regression back to `dev.enabled || od.enabled` fails this the moment
 * `developer_mode` is present without the feature addon.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useDeliveryAccess, useRoutesAccess } from "./addons";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useDeliveryAccess / useRoutesAccess — developer_mode no longer substitutes (B123)", () => {
  it("REG-B123 developer_mode alone (no feature addon) does not unlock delivery or routes access", async () => {
    mockedGet.mockResolvedValue({ data: { addons: ["developer_mode"] } });

    const delivery = renderHook(() => useDeliveryAccess(), { wrapper: Wrapper });
    const routes = renderHook(() => useRoutesAccess(), { wrapper: Wrapper });

    await waitFor(() => expect(delivery.result.current.resolved).toBe(true));
    await waitFor(() => expect(routes.result.current.resolved).toBe(true));

    // RED against the pre-fix `dev.enabled || od.enabled` composition, which
    // would report enabled: true here off developer_mode alone.
    expect(delivery.result.current.enabled).toBe(false);
    expect(routes.result.current.enabled).toBe(false);
  });

  it("the real feature addon (without developer_mode) still unlocks access", async () => {
    mockedGet.mockResolvedValue({ data: { addons: ["order_delivery", "recurring_routes"] } });

    const delivery = renderHook(() => useDeliveryAccess(), { wrapper: Wrapper });
    const routes = renderHook(() => useRoutesAccess(), { wrapper: Wrapper });

    await waitFor(() => expect(delivery.result.current.resolved).toBe(true));
    await waitFor(() => expect(routes.result.current.resolved).toBe(true));

    expect(delivery.result.current.enabled).toBe(true);
    expect(routes.result.current.enabled).toBe(true);
  });
});
