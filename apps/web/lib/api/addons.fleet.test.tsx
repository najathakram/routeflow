import { renderHook } from "@testing-library/react";
import { useFleetAccess } from "./addons";

// fleet-off ONLY when the fulfilment model was explicitly SET and the server says there is no fleet.
// Every other tenant (UNSET, inconsistent, loading/errored answer, an older API) keeps every surface.
let features: unknown;
jest.mock("../tenant-features", () => ({ useTenantFeatures: () => ({ data: features }) }));

const caps = (over: Record<string, unknown>) => ({
  capabilities: {
    fulfilment: {
      methods: ["SHIP"],
      staffDefault: "SHIP",
      staffOpensAs: "order",
      portalMethods: [],
      portalDefault: null,
      counter: "off",
      fleet: false,
      consistent: true,
      ...over,
    },
  },
});
const fleet = () => renderHook(() => useFleetAccess()).result.current.fleet;

describe("useFleetAccess", () => {
  beforeEach(() => {
    features = undefined;
  });

  it("M4: an UNSET tenant with no fleet module keeps today's nav (fleet true), whatever its modules", () => {
    // the UNSET shape: ROUTE/SHIP both offered, ROUTE default, no buyer choice
    features = caps({
      methods: ["ROUTE", "SHIP"],
      staffDefault: "ROUTE",
      counter: "off",
      fleet: false,
    });
    expect(fleet()).toBe(true);
  });

  it("an explicit ship-only account with no fleet IS fleet-off", () => {
    features = caps({});
    expect(fleet()).toBe(false);
  });

  it("an explicit ship-only account that holds a fleet module keeps the fleet surfaces", () => {
    features = caps({ fleet: true });
    expect(fleet()).toBe(true);
  });

  it("F-a: consistent=false (a delivery/both mode whose fleet is gone) reads as UNSET: today's UI", () => {
    features = caps({ methods: ["ROUTE"], staffDefault: "ROUTE", fleet: false, consistent: false });
    expect(fleet()).toBe(true);
  });

  it("fails open while loading, on an error, or on an older API without the block", () => {
    features = undefined;
    expect(fleet()).toBe(true);
    features = { capabilities: {} };
    expect(fleet()).toBe(true);
  });
});
