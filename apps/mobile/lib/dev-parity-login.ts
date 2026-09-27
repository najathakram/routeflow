/**
 * SECURITY TIER 1 — dev-only sign-in for the native-parity proof harness (#2338, epic #2328).
 *
 * The lead's ruling: agents sign the local test buyer in themselves and never ask the owner to log
 * in. `simctl` can deep-link and screenshot but cannot tap, so the simulator session comes from here.
 *
 * HARD GUARDS (all pinned by __tests__/dev-parity-login.test.ts):
 *   1. It does anything at all ONLY when `__DEV__` is true. The whole body, INCLUDING every
 *      read of process.env.EXPO_PUBLIC_PARITY_LOGIN and the "dev-parity-login" log marker, sits
 *      inside `if (__DEV__)`, so a production bundle (Metro folds `__DEV__` to false and drops the
 *      branch) carries none of it: neither the marker nor an inlined credential. The mobile web
 *      Docker build greps its production export for the marker and fails if it is there.
 *   2. AND EXPO_PUBLIC_PARITY_LOGIN is set. It is written only into the GITIGNORED
 *      apps/mobile/.env.parity by the harness, from the local `test` seed's fixtures
 *      (scripts/native-parity/fixtures.cjs). There is no credential literal in app code.
 *   3. AND the API base URL is loopback or a private LAN address (localhost, 127.0.0.0/8, ::1,
 *      10/8, 172.16/12, 192.168/16). Any other host is a no-op, so it can never sign in against a
 *      deployed API.
 * EXPO_PUBLIC_PARITY_LOGIN is referenced in this file ONLY (pinned). It signs in through the same
 * buyerLogin → getBuyerSellers → session store path the real login screen uses; nothing new server-side.
 */
import { buyerLogin, getBuyerSellers } from "./buyer-auth";
import { useBuyerSessionStore } from "./buyer-session-store";

export type ParityLoginResult = "skipped" | "already-signed-in" | "signed-in";

/** Pure: is `url`'s host loopback or a private (RFC 1918) address? Anything unparseable is no. */
export function isPrivateApiUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Pure: `{"email":"…","password":"…","seller":"test"}` → credentials, or null if malformed. */
export function parseParityLogin(
  raw: string | undefined,
): { email: string; password: string; seller?: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.email !== "string" || typeof v?.password !== "string") return null;
    if (!v.email || !v.password) return null;
    return {
      email: v.email,
      password: v.password,
      seller: typeof v.seller === "string" ? v.seller : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Called once at boot, after the buyer session store has loaded. Signs the parity buyer in when
 * every guard holds; otherwise does nothing. Never throws: a failed dev sign-in logs and leaves the
 * app on its normal login screen.
 */
export async function maybeDevParityLogin(env?: {
  parityLogin?: string;
  apiUrl?: string;
}): Promise<ParityLoginResult> {
  if (__DEV__) {
    // The env is read HERE, inside the dev branch, never in a default parameter: a production
    // build must not be able to inline EXPO_PUBLIC_PARITY_LOGIN into the bundle.
    const e = env ?? {
      parityLogin: process.env.EXPO_PUBLIC_PARITY_LOGIN,
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
    };
    const creds = parseParityLogin(e.parityLogin);
    if (!creds) return "skipped";
    if (!isPrivateApiUrl(e.apiUrl ?? "http://localhost:3000")) return "skipped";
    const store = useBuyerSessionStore.getState();
    if (store.buyer?.email?.toLowerCase() === creds.email.toLowerCase() && store.activeSeller) {
      return "already-signed-in";
    }
    try {
      const res = await buyerLogin(creds.email.toLowerCase(), creds.password);
      store.setBuyer(res.buyer);
      const sellers = await getBuyerSellers();
      const seller = sellers.find((s) => s.tenant?.slug === creds.seller) ?? sellers[0];
      if (!seller) return "skipped";
      await store.setActiveSeller(seller);
      console.warn(`[dev-parity-login] signed in ${creds.email} (local test fixture)`);
      return "signed-in";
    } catch (e: any) {
      console.warn(`[dev-parity-login] sign-in failed: ${e?.message ?? e}`);
      return "skipped";
    }
  }
  return "skipped";
}
