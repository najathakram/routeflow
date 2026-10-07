"use client";

import * as React from "react";

/**
 * PKG-8 (dashboard CLS). The Routes/Drivers stat slots depend on an add-on read that resolves
 * after first paint. Reserving a skeleton for a tenant that has NO routes would itself shift the
 * page when it disappears, so we reserve only when this tenant+user LAST resolved to routes ON.
 *
 * First visit / storage blocked / throwing accessor => `false` (do not reserve). The shell holds
 * no earlier signal: `(dashboard)/layout.tsx` reads the same `useTenantAddons` query the page does,
 * and `capabilities.fulfilment.fleet` (GET /tenants/me/features) is an equally late read.
 */
const KEY_PREFIX = "rf:dash:routes:";

export function lastKnownRoutesKey(tenantSlug: string | null | undefined, userId: string): string {
  return `${KEY_PREFIX}${tenantSlug ?? "-"}:${userId}`;
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* storage blocked — the reservation is a convenience only */
  }
}

const useIsoLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

/** `reserve` is true only while the add-on is unresolved AND it last resolved to ON. */
export function useLastKnownRoutesAccess(
  user: { id?: string; tenantSlug?: string | null } | null | undefined,
  routes: { enabled: boolean; resolved: boolean },
): boolean {
  const key = user?.id ? lastKnownRoutesKey(user.tenantSlug, user.id) : null;
  const [known, setKnown] = React.useState(false);
  useIsoLayoutEffect(() => {
    if (!key) return;
    if (routes.resolved) {
      write(key, routes.enabled);
      setKnown(routes.enabled);
    } else {
      setKnown(read(key));
    }
  }, [key, routes.resolved, routes.enabled]);
  return !routes.resolved && known;
}
