"use client";

import * as React from "react";

/** Tailwind's `sm` is 640px: below it the order-detail action bar is one row with a More menu. */
export const PHONE_QUERY = "(max-width: 639px)";

/**
 * True on a phone-width viewport (and always false where matchMedia is absent, e.g. jsdom).
 * The query is read in the initializer, so the first paint already has the right bar; the order
 * page renders only on the client after its data loads, so this never differs from a server render.
 */
export function usePhoneWidth(): boolean {
  const [phone, setPhone] = React.useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(PHONE_QUERY).matches,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return phone;
}
