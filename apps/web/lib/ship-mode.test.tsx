import { renderHook } from "@testing-library/react";
import { useShipMode } from "./ship-mode";

// SHIP semantics apply only when the account's fulfilment_model mode is exactly "ship". Anything else
// (absent, "unset", the other modes, loading, an error) is today's behaviour, so an existing tenant,
// including one with both fleet modules off, never changes.
let features: { data?: { modes?: Record<string, string> } };
jest.mock("./tenant-features", () => ({ useTenantFeatures: () => features }));

describe("useShipMode", () => {
  it("is true only for fulfilment_model = ship", () => {
    features = { data: { modes: { fulfilment_model: "ship" } } };
    expect(renderHook(() => useShipMode()).result.current).toBe(true);
  });

  it.each([["unset"], ["delivery"], ["both"], ["pickup"], [""]])("is false for mode %p", (mode) => {
    features = { data: { modes: { fulfilment_model: mode } } };
    expect(renderHook(() => useShipMode()).result.current).toBe(false);
  });

  it("is false when the key is absent, the modes are missing, or the answer is loading / failed", () => {
    features = { data: { modes: {} } };
    expect(renderHook(() => useShipMode()).result.current).toBe(false);
    features = { data: {} };
    expect(renderHook(() => useShipMode()).result.current).toBe(false);
    features = { data: undefined };
    expect(renderHook(() => useShipMode()).result.current).toBe(false);
  });
});
