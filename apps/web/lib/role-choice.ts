import { apiClient } from "./api-client";
import { safeOperatorRedirect } from "./portal-routing";

/**
 * W-839 / SA-937 MUST 6 (owner 2026-10-24: a user who is both a driver and a buyer is ASKED at sign-in which role to
 * use). ONE web post-staff-sign-in step, used by the password login and the Google staff callback, and rendered by the
 * mobile shell; never a native screen. `forcePasswordChange` is decided before any of this, by the callers.
 */
export const CHOOSE_ROLE_PATH = "/choose-role";

type StaffLike = { role?: string | null; canActAsDriver?: boolean | null } | null | undefined;

/** The user drives: a DRIVER, or staff allowed to act as one. Widening the picker to other roles is this one line. */
export function drives(user: StaffLike): boolean {
  return user?.role === "DRIVER" || user?.canActAsDriver === true;
}

/** The ONE predicate (SA-937 MUST 6): drives, also an ACTIVE buyer of this tenant, and no explicit redirect asked for. */
export function shouldAskRole(
  user: StaffLike,
  alsoBuyer: boolean | null | undefined,
  explicitRedirect: string | null | undefined,
): boolean {
  return drives(user) && alsoBuyer === true && !explicitRedirect;
}

/**
 * Where a staff sign-in goes next: the role step when asked, else today's landing. When it asks it also remembers that
 * landing, so Drive on the step keeps the landing of the path the user signed in on (#3731 review 2: the Google path
 * lands on /dashboard, the password login on the role's landing).
 */
export function postSignInDestination(
  user: StaffLike,
  alsoBuyer: boolean | null | undefined,
  explicitRedirect: string | null | undefined,
  landing: string,
): string {
  if (!shouldAskRole(user, alsoBuyer, explicitRedirect)) return landing;
  rememberRoleStepLanding(landing);
  return CHOOSE_ROLE_PATH;
}

const ROLE_STEP_LANDING_KEY = "rf.roleStep.landing";

/** Session storage can be absent or refuse (private mode): every read and write here is best-effort. */
function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberRoleStepLanding(landing: string): void {
  try {
    session()?.setItem(ROLE_STEP_LANDING_KEY, landing);
  } catch {
    /* best-effort */
  }
}

/** The landing the entry path remembered (a same-origin operator path only), else `fallback`. */
export function roleStepLanding(fallback: string): string {
  let stored: string | null = null;
  try {
    stored = session()?.getItem(ROLE_STEP_LANDING_KEY) ?? null;
  } catch {
    /* best-effort */
  }
  if (!stored) return fallback;
  const safe = safeOperatorRedirect(stored);
  return safe === stored ? stored : fallback;
}

/**
 * GET /users/me's `alsoBuyer` (SA-937 MUST 1: the only place it is carried). Read only for a user who drives, so
 * nobody else pays for the call; a failed read is false (today's landing, never a stuck sign-in).
 */
export async function readAlsoBuyer(user: StaffLike): Promise<boolean> {
  if (!drives(user)) return false;
  try {
    const { data } = await apiClient.get<{ alsoBuyer?: boolean }>("/users/me");
    return data?.alsoBuyer === true;
  } catch {
    return false;
  }
}

/** "Shop": the web buyer login. The email prefill (SA-937 MUST 5) is stashed, never put in the URL (#3731 review 4). */
export const BUYER_LOGIN_PATH = "/buyer/login";
const BUYER_LOGIN_EMAIL_KEY = "rf.buyerLogin.email";

export function stashBuyerLoginEmail(email: string | null | undefined): void {
  try {
    if (email) session()?.setItem(BUYER_LOGIN_EMAIL_KEY, email);
    else session()?.removeItem(BUYER_LOGIN_EMAIL_KEY);
  } catch {
    /* best-effort */
  }
}

/** The stashed email, read ONCE (removed as it is read), or null. */
export function takeBuyerLoginEmail(): string | null {
  try {
    const s = session();
    const email = s?.getItem(BUYER_LOGIN_EMAIL_KEY) ?? null;
    s?.removeItem(BUYER_LOGIN_EMAIL_KEY);
    return email;
  } catch {
    return null;
  }
}
