import type { BannerDismiss } from "./subscription-banner-state";

/**
 * SA-733r6 (B4): the per-viewer "dismissed" memory for the billing strip. A convenience only (localStorage, every
 * access in try/catch): when storage is unavailable the strip simply shows again. The key already carries what
 * makes a dismissal expire early (the local day, the invoice, the card); `until` covers the rest.
 */
const PREFIX = "rf.banner.dismissed.";
const DAY_MS = 86_400_000;

export function isBannerDismissed(d: BannerDismiss, now: number = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(PREFIX + d.key);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

export function dismissBanner(d: BannerDismiss, now: number = Date.now()): void {
  const until = now + (d.scope === "week" ? 7 * DAY_MS : DAY_MS);
  try {
    window.localStorage.setItem(PREFIX + d.key, String(until));
  } catch {
    /* storage unavailable: the strip shows again next load */
  }
}
