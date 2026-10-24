/**
 * POS-7: "register mode" - the shell's counter look. It is derived from the route alone (true only on the counter
 * screen); there is no layout group and no stored flag. Also the previous-path tracker behind the header's Exit.
 */
export const COUNTER_PATH = "/orders/counter-sale";
export const REGISTER_FALLBACK_PATH = "/dashboard";
const PREV_KEY = "rf-register-prev";

const pathOnly = (p: string) => p.split(/[?#]/)[0].replace(/\/+$/, "") || "/";

export function isRegisterPath(pathname: string | null | undefined): boolean {
  return typeof pathname === "string" && pathOnly(pathname) === COUNTER_PATH;
}

/** A path Exit may navigate to: same-origin internal, one leading "/", no protocol, and never the counter itself. */
export function isSafeExitPath(p: unknown): p is string {
  if (typeof p !== "string" || !/^\/(?![/\\])[^\s\\]*$/.test(p)) return false;
  try {
    if (new URL(p, "http://x.invalid").origin !== "http://x.invalid") return false;
  } catch {
    return false;
  }
  return !isRegisterPath(p);
}

/** Remember the last dashboard page that is not the counter. Storage may be blocked: never throws. */
export function recordPreviousPath(pathname: string): void {
  if (!isSafeExitPath(pathname)) return;
  try {
    sessionStorage.setItem(PREV_KEY, pathname);
  } catch {
    /* blocked storage: Exit falls back to /dashboard */
  }
}

export function readExitTarget(): string {
  try {
    const p = sessionStorage.getItem(PREV_KEY);
    if (isSafeExitPath(p)) return p;
  } catch {
    /* blocked storage */
  }
  return REGISTER_FALLBACK_PATH;
}
