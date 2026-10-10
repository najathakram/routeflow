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
 *   3. AND the API base URL is the SIMULATOR'S OWN loopback, over http(s) only: exactly
 *      localhost, 127.0.0.1, ::1, or 10.0.2.2 (the Android emulator's alias for the host). The
 *      harness is simulator-only, so no LAN address, no other scheme and no other host qualifies;
 *      it can never sign in against a deployed API (Opus fold).
 *   4. The seller is REQUIRED and must be one the buyer is linked to. There is no default-tenant
 *      fallback: if it is missing, the half-finished sign-in is cleared (store signOut).
 * EXPO_PUBLIC_PARITY_LOGIN is referenced in this file ONLY (pinned). It signs in through the same
 * buyerLogin → getBuyerSellers → session store path the real login screen uses; nothing new server-side.
 */
import { buyerLogin, getBuyerSellers } from "./buyer-auth";
import { useBuyerSessionStore } from "./buyer-session-store";

export type ParityLoginResult = "skipped" | "already-signed-in" | "signed-in";

const SIMULATOR_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "10.0.2.2"]);

/** Pure: is `url` an http(s) URL on the simulator's own loopback? Anything else, or unparseable, is no. */
export function isSimulatorApiUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return SIMULATOR_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ""));
}

/** Pure: `{"email":"…","password":"…","seller":"test"}` → credentials, or null if malformed. */
export function parseParityLogin(
  raw: string | undefined,
): { email: string; password: string; seller: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.email !== "string" || typeof v?.password !== "string") return null;
    if (typeof v?.seller !== "string") return null; // no default-tenant fallback (Opus fold)
    if (!v.email || !v.password || !v.seller) return null;
    return { email: v.email, password: v.password, seller: v.seller };
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
    if (!isSimulatorApiUrl(e.apiUrl ?? "http://localhost:3000")) return "skipped";
    const store = useBuyerSessionStore.getState();
    if (store.buyer?.email?.toLowerCase() === creds.email.toLowerCase() && store.activeSeller) {
      return "already-signed-in";
    }
    let signedIn = false;
    try {
      const res = await buyerLogin(creds.email.toLowerCase(), creds.password);
      store.setBuyer(res.buyer);
      signedIn = true;
      const sellers = await getBuyerSellers();
      // The NAMED seller only: never a default tenant (Opus fold).
      const seller = sellers.find((s) => s.tenant?.slug === creds.seller);
      if (!seller) throw new Error(`the parity buyer is not linked to "${creds.seller}"`);
      await store.setActiveSeller(seller);
      console.warn(`[dev-parity-login] signed in ${creds.email} (local test fixture)`);
      return "signed-in";
    } catch (e: any) {
      // Never leave a half-finished session: a buyer set without its seller is cleared.
      if (signedIn) {
        try {
          await store.signOut();
        } catch {
          // Best-effort: signOut already clears local tokens even if the server call fails.
        }
      }
      console.warn(`[dev-parity-login] sign-in failed: ${e?.message ?? e}`);
      return "skipped";
    }
  }
  return "skipped";
}
