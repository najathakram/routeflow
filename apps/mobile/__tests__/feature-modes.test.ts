import { getRoutesDispatchVisibility } from "../lib/feature-modes";

/**
 * Feature grants v2 brief C (PR-5), oracle 5 (parity, unit level) — mirrors
 * apps/web/lib/feature-modes.test.ts. With no `modes` data (the pre-PR/no-config-row shape)
 * both entry points show, matching today's behavior exactly.
 */
describe("getRoutesDispatchVisibility (mobile)", () => {
  it("HARD INVARIANT — undefined modes shows both entry points, same as today", () => {
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

  it("an unrecognized mode string fails open (shows both)", () => {
    expect(getRoutesDispatchVisibility({ routes_dispatch: "some_future_mode" })).toEqual({
      showScheduledEntry: true,
      showAdhocEntry: true,
    });
  });
});
