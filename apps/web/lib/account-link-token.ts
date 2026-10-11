"use client";

import * as React from "react";

/**
 * Single-use account links (password reset / set-password, buyer email verification, buyer
 * merge verification) carry their token in the URL FRAGMENT: `…/reset-password#t=<token>`.
 * A fragment is never sent to a server, never written to an access log and never carried in a
 * Referer header. The page reads it once, scrubs it from the address bar, keeps it in memory
 * and POSTs it in a request BODY.
 *
 * Links emailed before the fragment format carry `?token=<token>`. Each page keeps reading that
 * legacy query form until the longest lifetime of a link of its flow has passed since the cutover
 * (same TTLs the API issues), then ignores it.
 */

export type AccountLinkFlow =
  "staffReset" | "staffVerifyEmail" | "buyerReset" | "buyerVerifyEmail" | "buyerMerge";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Link lifetime per flow, mirroring the API (set-password 72h, reset 15 min, verify/merge 24h). */
export const LEGACY_LINK_TTL_MS: Readonly<Record<AccountLinkFlow, number>> = {
  // /reset-password serves both a 72h set-password link and a 15 min self-service reset.
  staffReset: 72 * HOUR_MS,
  staffVerifyEmail: 24 * HOUR_MS,
  buyerReset: 15 * MINUTE_MS,
  buyerVerifyEmail: 24 * HOUR_MS,
  buyerMerge: 24 * HOUR_MS,
};

/**
 * When the API started emailing fragment links. Set to (or after) the real deploy time: a later
 * value only lengthens the legacy window; an earlier one would drop live legacy links.
 */
export const LINK_FORMAT_CUTOVER_AT_MS = Date.parse("2026-10-14T00:00:00Z");

/** True while a `?token=` link emailed before the cutover could still be valid. */
export function legacyQueryTokenAccepted(flow: AccountLinkFlow, now: number = Date.now()): boolean {
  return now < LINK_FORMAT_CUTOVER_AT_MS + LEGACY_LINK_TTL_MS[flow];
}

const MAX_TOKEN_LENGTH = 512;

function clean(value: string | null): string {
  const v = (value ?? "").trim();
  return v.length > 0 && v.length <= MAX_TOKEN_LENGTH ? v : "";
}

/** `#t=<token>` → token (empty string when absent). */
export function tokenFromHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return clean(new URLSearchParams(raw).get("t"));
}

/** Fragment `t` first, else (inside the legacy window) the old `token` query param. */
export function readAccountLinkToken(
  loc: { hash: string; search: string },
  flow: AccountLinkFlow,
  now: number = Date.now(),
): string {
  const fromHash = tokenFromHash(loc.hash);
  if (fromHash) return fromHash;
  if (!legacyQueryTokenAccepted(flow, now)) return "";
  return clean(new URLSearchParams(loc.search).get("token"));
}

/** Drops the fragment and the `token` query param from the address bar (other params stay). */
export function scrubAccountLinkToken(win: Pick<Window, "location" | "history">): void {
  const { pathname, search, hash } = win.location;
  if (!hash && !search) return;
  const params = new URLSearchParams(search);
  params.delete("token");
  const rest = params.toString();
  win.history.replaceState(null, "", rest ? `${pathname}?${rest}` : pathname);
}

/**
 * Reads the link token once on the client (the server cannot see a fragment), scrubs the address
 * bar, and keeps the token in memory. `ready` is false until that has happened, so a page never
 * flashes an "invalid link" state while hydrating. Never logs the token.
 */
export function useAccountLinkToken(flow: AccountLinkFlow): { token: string; ready: boolean } {
  const [state, setState] = React.useState({ token: "", ready: false });
  // A ref survives React strict-mode's double effect run: the second run would otherwise read
  // the already-scrubbed address bar and overwrite the token with "".
  const captured = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (captured.current === null) {
      captured.current = readAccountLinkToken(window.location, flow);
      scrubAccountLinkToken(window);
    }
    setState({ token: captured.current, ready: true });
  }, [flow]);
  return state;
}
