import {
  claimCounterLanding,
  isCounterPrefAvailable,
  OPEN_COUNTER_KEY,
  readOpenCounterPref,
  resetCounterLandingForTests,
  shouldOpenCounter,
  writeOpenCounterPref,
} from "./counter-device-pref";

/** POS-7: "Open the counter on this device" - a localStorage flag, a pure redirect decision, a once-per-session claim. */

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetCounterLandingForTests();
});

const base = {
  pathname: "/dashboard",
  isStaff: true,
  impersonating: false,
  counterEnabled: true,
  pref: true,
};

describe("device preference storage", () => {
  it("persists on and off", () => {
    expect(readOpenCounterPref()).toBe(false);
    expect(writeOpenCounterPref(true)).toBe(true);
    expect(localStorage.getItem(OPEN_COUNTER_KEY)).toBe("true");
    expect(readOpenCounterPref()).toBe(true);
    expect(writeOpenCounterPref(false)).toBe(true);
    expect(readOpenCounterPref()).toBe(false);
  });

  it("is available when storage works", () => {
    expect(isCounterPrefAvailable()).toBe(true);
  });

  it("is unavailable, reads false and does not throw when storage throws", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(isCounterPrefAvailable()).toBe(false);
    expect(readOpenCounterPref()).toBe(false);
    expect(writeOpenCounterPref(true)).toBe(false);
  });
});

describe("shouldOpenCounter", () => {
  it("opens at exactly /dashboard for staff with the counter on and the preference set", () => {
    expect(shouldOpenCounter(base)).toBe(true);
  });

  it("never opens at any other path", () => {
    for (const pathname of [
      "/dashboard/",
      "/dashboard/x",
      "/orders",
      "/orders/counter-sale",
      "/",
    ]) {
      expect(shouldOpenCounter({ ...base, pathname })).toBe(false);
    }
  });

  it("is skipped for non-staff, impersonation, counter off and preference off", () => {
    expect(shouldOpenCounter({ ...base, isStaff: false })).toBe(false);
    expect(shouldOpenCounter({ ...base, impersonating: true })).toBe(false);
    expect(shouldOpenCounter({ ...base, counterEnabled: false })).toBe(false);
    expect(shouldOpenCounter({ ...base, pref: false })).toBe(false);
  });
});

describe("claimCounterLanding", () => {
  it("is true once per session, then false", () => {
    expect(claimCounterLanding()).toBe(true);
    expect(claimCounterLanding()).toBe(false);
  });

  it("still claims once when sessionStorage throws", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(claimCounterLanding()).toBe(true);
    expect(claimCounterLanding()).toBe(false);
  });
});
