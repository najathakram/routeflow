import * as React from "react";

/**
 * SA-1067 M2 + A-2: one Enter must never commit a value nobody chose. A scanner keyboard ends every code in Enter and
 * cannot press anything else (the PKG-4 rule in `use-listbox-nav.ts`), so a field where Enter commits needs a second
 * Enter on the SAME value. `key` names what Enter would commit. An arm lasts only while that value stands: ANY change of
 * `key` ends it, even if the same value comes back, so a clerk who clears the field and scans again, or a scan that lands
 * in a field, always meets an unarmed hook and can only arm. The hook does this itself, so no caller can forget it.
 * Pointer actions and focused buttons don't go through this.
 */
export function useArmedEnter(key: string) {
  const [armedKey, setArmedKey] = React.useState<string | null>(null);
  // Derived at render: an arm made for another key is no arm. The effect below also forgets it, so the same key
  // coming back later finds no stale arm to match.
  const armed = armedKey === key;
  React.useEffect(() => {
    setArmedKey((cur) => (cur === null || cur === key ? cur : null));
  }, [key]);
  /** Commits when no second Enter is needed or `key` is already armed; otherwise arms `key`. */
  const press = (needsSecond: boolean, commit: () => void) => {
    if (!needsSecond || armed) {
      setArmedKey(null);
      commit();
    } else {
      setArmedKey(key);
    }
  };
  const disarm = React.useCallback(() => setArmedKey(null), []);
  return { press, armed, disarm };
}
