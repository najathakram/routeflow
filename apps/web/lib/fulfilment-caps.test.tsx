import { renderHook } from "@testing-library/react";
import { useStaffFulfilment, useFulfilmentCaps } from "./fulfilment-caps";

// Gating reads ONLY capabilities.fulfilment. Anything unknown (loading, error, an API without the block)
// is the UNSET shape = today's behaviour: ROUTE + SHIP offered (picker shown), ROUTE default, no buyer choice.
let data: unknown;
jest.mock("./tenant-features", () => ({ useTenantFeatures: () => ({ data }) }));

const caps = (o: Record<string, unknown>) => ({
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  ...o,
});
const shipOnly = caps({ methods: ["SHIP"], staffDefault: "SHIP", fleet: false });

describe("useFulfilmentCaps / useStaffFulfilment", () => {
  it.each([[undefined], [{}], [{ capabilities: {} }]])("unset when the answer is %j", (d) => {
    data = d;
    const { result } = renderHook(() => useStaffFulfilment());
    expect(result.current.choice).toBe(true);
    expect(result.current.staffDefault).toBe("ROUTE");
    expect(renderHook(() => useFulfilmentCaps()).result.current.portalMethods).toEqual([]);
  });

  it("a ship-only account: no picker, SHIP default", () => {
    data = { capabilities: { fulfilment: shipOnly } };
    const { result } = renderHook(() => useStaffFulfilment());
    expect(result.current.choice).toBe(false);
    expect(result.current.staffDefault).toBe("SHIP");
  });

  it("the customer's own path pre-selects first, but only when the account offers it", () => {
    data = { capabilities: { fulfilment: shipOnly } };
    expect(renderHook(() => useStaffFulfilment()).result.current.pick("ROUTE")).toBe("SHIP");
    data = { capabilities: { fulfilment: caps({ staffDefault: "SHIP" }) } };
    expect(renderHook(() => useStaffFulfilment()).result.current.pick("ROUTE")).toBe("ROUTE");
    expect(renderHook(() => useStaffFulfilment()).result.current.pick(null)).toBe("SHIP");
  });
});
