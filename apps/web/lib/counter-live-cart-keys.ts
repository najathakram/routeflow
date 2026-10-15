/**
 * The live counter cart (SA-748 section 1): the unfinished sale on this till, kept in localStorage so a refresh or a crashed
 * tab does not lose it. Per signed-in tenant + user. This file holds only the key and the wipe, so the auth layer can import
 * it on logout without pulling the counter code in.
 */
export const LIVE_CART_KEY = "rf.counterSale.liveCart";

/** The storage key for one signed-in tenant + user, or null when either is unknown (then nothing is stored or restored). */
export function liveCartKey(tenant?: string | null, userId?: string | null): string | null {
  return tenant && userId ? `${LIVE_CART_KEY}:${tenant}:${userId}` : null;
}

/** Logout: drop every stored live cart on this browser, whoever it belonged to. */
export function clearAllLiveCarts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(`${LIVE_CART_KEY}:`)) doomed.push(k);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* storage unavailable: nothing was kept */
  }
}
