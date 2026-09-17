import { getRoutesDispatchVisibility } from "./feature-modes";

/**
 * Feature grants v2 brief C (PR-5), oracle 5 (parity, unit level) — with no `modes` data (the
 * pre-PR/no-config-row shape) both entry points show, byte-for-byte the same decision as before
 * this file existed. `scheduled`/`adhoc` hide the opposite entry point only when explicitly set.
 */
describe("getRoutesDispatchVisibility", () => {
  it("HARD INVARIANT — undefined modes (no hook data yet / fixture tenant with no config row) shows both entry points, same as today", () => {
    expect(getRoutesDispatchVisibility(undefined)).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
    expect(getRoutesDispatchVisibility(null)).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });

  it('"unset" shows both entry points', () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "unset" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });

  it('"scheduled" hides the ad-hoc entry point only', () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "scheduled" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: false,
    });
  });

  it('"adhoc" hides the scheduled entry point only', () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "adhoc" })).toEqual({
      showScheduledEntry: false,
      showAdhocEntry: true,
    });
  });

  it('"mixed" shows both entry points', () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "mixed" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });

  it("an unrecognized mode string fails open (shows both), never narrows on an unknown value", () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "some_future_mode" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });

  it("ignores unrelated keys in the modes record", () => {
    expect(getRoutesDispatchVisibility({ catalog_varieties: "child_skus" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });
});
