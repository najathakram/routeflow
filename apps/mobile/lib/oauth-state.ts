/**
 * F12-005 — OAuth deep-link session-fixation guard (pure logic).
 *
 * The Google OAuth flow returns tokens to the app via a `routeflow://` deep link.
 * A custom-scheme deep link can be fired by ANY other app or web page, so tokens
 * arriving on that link must be proven to belong to a flow THIS device started.
 *
 * We bind the flow with a device-generated `state` nonce: generate it before
 * opening the browser, persist it (SecureStore), pass it through the OAuth flow,
 * and only accept the callback when the returned `state` matches the stored one.
 *
 * This module is intentionally dependency-free and side-effect-free so it can be
 * unit-tested in plain Node (see apps/mobile/__tests__/oauth-state.test.ts).
 */

/** Storage key for the pending-flow state nonce (SecureStore / localStorage). */
export const OAUTH_STATE_KEY = "rf:oauth:pendingState";

/** Number of random bytes in a state nonce (256 bits). */
const STATE_BYTES = 32;

/**
 * Best-available cryptographic random bytes. Uses the Web Crypto API when the
 * runtime exposes it (browsers, react-native-web, Node ≥ 18, any RN build with a
 * crypto polyfill). Falls back to a non-CSPRNG source only when Web Crypto is
 * absent so the app never crashes — the state stays single-use and short-lived,
 * so even the fallback meaningfully binds the flow.
 */
function defaultRandomBytes(n: number): Uint8Array {
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  };
  const out = new Uint8Array(n);
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/**
 * Generate an unguessable, URL-safe state nonce. `randomBytes` is injectable for
 * deterministic tests; production callers omit it and get the default CSPRNG.
 */
export function generateOAuthState(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  return toHex(randomBytes(STATE_BYTES));
}

/**
 * Constant-shape validation: the returned state is accepted ONLY when a state
 * was stored for this flow AND the returned value matches it exactly. A missing
 * stored value (no flow pending — i.e. an unsolicited deep link) or a missing /
 * mismatched returned value is rejected.
 */
export function isValidReturnedState(
  stored: string | null | undefined,
  returned: string | null | undefined,
): boolean {
  if (!stored || !returned) return false;
  return stored === returned;
}
