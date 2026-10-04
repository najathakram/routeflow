import { renderHook } from "@testing-library/react";
import { useFleetAccess } from "./addons";

// A tenant is FLEET-OFF only when it holds neither recurring_routes nor order_delivery AND the addons
// answer is actually known. Anything unknown (loading, fetch error) fails OPEN (fleet UI), exactly like
// the RouteGuard rule: a tenant is never shown a stripped-down UI on a guess.
let addons: { data?: { addons: string[] }; isLoading: boolean; isSuccess: boolean };
jest.mock("./tobacco", () => ({ useTenantAddons: () => addons }));

const ok = (list: string[]) => ({ data: { addons: list }, isLoading: false, isSuccess: true });

describe("useFleetAccess", () => {
  it.each([
    [["recurring_routes"], true],
    [["order_delivery"], true],
    [["recurring_routes", "order_delivery"], true],
    [["sales_agents"], false],
    [[], false],
  ])("addons %j resolved -> fleet %s", (list, expected) => {
    addons = ok(list as string[]);
    const { result } = renderHook(() => useFleetAccess());
    expect(result.current).toEqual({ fleet: expected, loading: false });
  });

  it("fails open while the addons are loading", () => {
    addons = { data: undefined, isLoading: true, isSuccess: false };
    const { result } = renderHook(() => useFleetAccess());
    expect(result.current).toEqual({ fleet: true, loading: true });
  });

  it("fails open when the addons fetch errored (never strips the UI on an unknown answer)", () => {
    addons = { data: undefined, isLoading: false, isSuccess: false };
    const { result } = renderHook(() => useFleetAccess());
    expect(result.current.fleet).toBe(true);
  });
});
