/**
 * Session re-auth bridge.
 *
 * When the operator access token expires and the refresh token can no longer
 * mint a new one, `api-client.ts` normally hard-redirects to /login — which
 * throws away any in-progress work (draft orders, half-filled forms).
 *
 * Instead, a `ReAuthProvider` (React) registers a handler here; `api-client`
 * calls `requestReauth()` and pauses the failed request until the user unlocks
 * the session in place (or chooses another account). No navigation, no lost
 * drafts. If no handler is mounted (e.g. the buyer portal, which uses its own
 * client), `requestReauth()` resolves `false` and the caller falls back to the
 * old redirect behavior.
 */

export interface ReauthRequest {
  /** Username to pre-fill / label the unlock sheet with. */
  username: string;
}

/** Resolves `true` once the session is unlocked (fresh tokens stored), or
 *  `false` if the user declined (switch account / cancel). */
export type ReauthHandler = (req: ReauthRequest) => Promise<boolean>;

let handler: ReauthHandler | null = null;

/** Register the sheet handler. Returns an unregister fn. Call once, from the
 *  ReAuthProvider mounted near the app root. */
export function registerReauthHandler(next: ReauthHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

export function hasReauthHandler(): boolean {
  return handler !== null;
}

/** Ask the mounted sheet to re-authenticate. Resolves false when no sheet is
 *  mounted so callers can fall back to a redirect. */
export function requestReauth(req: ReauthRequest): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  return handler(req);
}
