import { renderHook } from "@testing-library/react";
import { useFleetAccess } from "./addons";

// fleet = the server's capabilities.fulfilment.fleet when present, else routes||delivery from the add-ons.
// Fails OPEN (fleet UI) while unknown, so a tenant is never stripped on a guess.
let addons: { data?: { addons: string[] }; isLoading: boolean; isSuccess: boolean };
let features: unknown;
jest.mock("./tobacco", () => ({ useTenantAddons: () => addons }));
jest.mock("../tenant-features", () => ({ useTenantFeatures: () => ({ data: features }) }));

const ok = (list: string[]) => ({ data: { addons: list }, isLoading: false, isSuccess: true });

describe("useFleetAccess", () => {
  beforeEach(() => {
    features = undefined;
  });

  it.each([
    [["recurring_routes"], true],
    [["order_delivery"], true],
    [["recurring_routes", "order_delivery"], true],
    [["sales_agents"], false],
    [[], false],
  ])("add-ons %j (no capabilities) -> fleet %s", (list, expected) => {
    addons = ok(list as string[]);
    expect(renderHook(() => useFleetAccess()).result.current).toEqual({
      fleet: expected,
      loading: false,
    });
  });

  it("the server's capabilities.fulfilment.fleet wins over the add-ons", () => {
    addons = ok(["recurring_routes"]);
    features = { capabilities: { fulfilment: { fleet: false } } };
    expect(renderHook(() => useFleetAccess()).result.current.fleet).toBe(false);
    addons = ok([]);
    features = { capabilities: { fulfilment: { fleet: true } } };
    expect(renderHook(() => useFleetAccess()).result.current.fleet).toBe(true);
  });

  it("fails open while loading or when the add-ons fetch errored", () => {
    addons = { data: undefined, isLoading: true, isSuccess: false };
    expect(renderHook(() => useFleetAccess()).result.current).toEqual({
      fleet: true,
      loading: true,
    });
    addons = { data: undefined, isLoading: false, isSuccess: false };
    expect(renderHook(() => useFleetAccess()).result.current.fleet).toBe(true);
  });
});
