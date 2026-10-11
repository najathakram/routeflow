/**
 * The invite token's client-side hand-over between this page and the sign-in / register pages.
 *
 * Those links carry `?redirect=/buyer/invite` and nothing else, because a token must never ride in
 * a URL. Just before leaving, the page parks the token in sessionStorage (this tab only); the
 * invite page reads it back once on return and removes it. Storage can be blocked (private mode,
 * site data cleared), so every access is guarded and the page works without it.
 */
export const INVITE_HANDOFF_KEY = "rf_invite_t";

export function stashInviteHandoff(token: string): void {
  if (!token) return;
  try {
    window.sessionStorage.setItem(INVITE_HANDOFF_KEY, token);
  } catch {
    /* storage unavailable: the visitor re-opens the emailed link */
  }
}

/** Returns the parked token (or "") and clears it: a hand-over is used once. */
export function takeInviteHandoff(): string {
  try {
    const value = window.sessionStorage.getItem(INVITE_HANDOFF_KEY) ?? "";
    window.sessionStorage.removeItem(INVITE_HANDOFF_KEY);
    return value.length > 0 && value.length <= 512 ? value : "";
  } catch {
    return "";
  }
}
