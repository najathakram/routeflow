"use client";

import * as React from "react";
import { hasBuyerPresence, hasOpPresence } from "@/lib/presence-cookies";

export interface PortalPresence {
  op: boolean;
  buyer: boolean;
}

const NONE: PortalPresence = { op: false, buyer: false };

/**
 * Presence cookies, read AFTER mount — never during render — so the server
 * render and the first client render agree (no hydration mismatch). Until the
 * effect runs, callers see "no presence" and render their sign-in variant.
 */
export function usePortalPresence(): PortalPresence {
  const [presence, setPresence] = React.useState<PortalPresence>(NONE);
  React.useEffect(() => {
    setPresence({ op: hasOpPresence(), buyer: hasBuyerPresence() });
  }, []);
  return presence;
}
