/**
 * B204 — expo-secure-store rejects every storage key this app defines.
 *
 * Native token storage validates keys against `/^[\w.-]+$/` and THROWS on
 * anything else (SecureStore.ts `ensureValidKey`, applied to reads and writes
 * alike). Our keys are colon-namespaced (`rf:op:accessToken`,
 * `rf:buyer:accessToken`, `rf:currentRole`, `rf:oauth:pendingState`, …), so on
 * a device every session read/write threw: the buyer boot gate hung the app on
 * the splash spinner (its initialize had no catch), and even past boot no
 * login could ever persist. Web never noticed — there these keys go to
 * localStorage, which accepts any string, and until the first APK existed no
 * code path had ever actually reached SecureStore.
 *
 * The fix is a NATIVE-ONLY spelling change at the storage boundary: web keeps
 * the exact keys it has always used (nobody gets signed out), and the native
 * branch maps each key through this function. There is no native install base
 * yet, so there is nothing to migrate — this defines the native format.
 *
 * Every call into expo-secure-store MUST route its key through here. Do not
 * add a colon-free key to dodge the mapper: the mapper is total and
 * idempotent, and `__tests__/secure-key.test.ts` pins that the REAL key set
 * stays collision-free after mapping — a hand-rolled parallel spelling would
 * sit outside that proof.
 */

/** Spell `key` the way the native secure store requires: every character
 *  outside `[A-Za-z0-9_.-]` becomes `_`. Idempotent; identity for keys that
 *  are already valid (e.g. `tenantSlug`). */
export function toSecureStoreKey(key: string): string {
  return key.replace(/[^\w.-]/g, "_");
}
