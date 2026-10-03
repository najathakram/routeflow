"use client";

import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

interface MotionValue {
  reduced: boolean;
}

const MotionContext = React.createContext<MotionValue | null>(null);

/** Reads the OS preference. SSR-safe: the server and first client render say `reduce`, then it syncs. */
function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(true);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    const sync = () => setReduced(mql.matches);
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

/** Exposes `{reduced}` to every kit part below it. Without one, parts read the OS preference directly. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  const reduced = useOsReducedMotion();
  const value = React.useMemo(() => ({ reduced }), [reduced]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

/** True when the user prefers reduced motion (OS setting). Every kit transition reads this. */
export function useReducedMotion(): boolean {
  const ctx = React.useContext(MotionContext);
  const os = useOsReducedMotion();
  return ctx ? ctx.reduced : os;
}
