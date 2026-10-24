import { REGISTER_FALLBACK_PATH } from "./register-mode";

/**
 * POS-7: "Open the counter on this device" - a per-device localStorage flag (try/catch everywhere: blocked storage hides the
 * control and the feature stays off). Landing at EXACTLY /dashboard with it on goes to the counter, once per session.
 */
export const OPEN_COUNTER_KEY = "rf-open-counter";
const LANDED_KEY = "rf-counter-landed";
let landedInMemory = false; // the once-per-session fallback when sessionStorage is blocked

export function isCounterPrefAvailable(): boolean {
  try {
    const probe = "rf-pref-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readOpenCounterPref(): boolean {
  try {
    return localStorage.getItem(OPEN_COUNTER_KEY) === "true";
  } catch {
    return false;
  }
}

/** Returns whether the write stuck. */
export function writeOpenCounterPref(on: boolean): boolean {
  try {
    localStorage.setItem(OPEN_COUNTER_KEY, String(on));
    return true;
  } catch {
    return false;
  }
}

export function shouldOpenCounter(i: {
  pathname: string | null | undefined;
  isStaff: boolean;
  impersonating: boolean;
  counterEnabled: boolean;
  pref: boolean;
}): boolean {
  return (
    i.pathname === REGISTER_FALLBACK_PATH &&
    i.isStaff &&
    !i.impersonating &&
    i.counterEnabled &&
    i.pref
  );
}

/** True the first time per browser session (the redirect and its toast happen once, so Exit -> /dashboard never bounces back). */
export function claimCounterLanding(): boolean {
  if (landedInMemory) return false;
  landedInMemory = true;
  try {
    if (sessionStorage.getItem(LANDED_KEY)) return false;
    sessionStorage.setItem(LANDED_KEY, "1");
  } catch {
    /* blocked: the in-memory flag still holds for this page life */
  }
  return true;
}

export function resetCounterLandingForTests(): void {
  landedInMemory = false;
}
