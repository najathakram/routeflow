import * as React from "react";

/**
 * SA-1067 M2: one Enter must never commit a value nobody chose. A scanner keyboard ends every code in Enter and cannot
 * press anything else (the PKG-4 rule in `use-listbox-nav.ts`), so a field where Enter commits needs a second Enter on
 * the SAME value. `key` names what Enter would commit; any edit changes it, and a scan always types first, so a scan's
 * Enter meets a changed key and can only arm. Pointer actions and focused buttons don't go through this.
 */
export function useArmedEnter() {
  const [armed, setArmed] = React.useState<string | null>(null);
  /** Commits when no second Enter is needed or `key` is already armed; otherwise arms `key`. */
  const press = (key: string, needsSecond: boolean, commit: () => void) => {
    if (!needsSecond || armed === key) {
      setArmed(null);
      commit();
    } else {
      setArmed(key);
    }
  };
  const disarm = React.useCallback(() => setArmed(null), []);
  return { press, isArmed: (key: string) => armed === key, disarm };
}
