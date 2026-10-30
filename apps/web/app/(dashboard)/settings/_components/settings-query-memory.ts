/**
 * W-937: the ONE owner of "the settings finder's query survives Back". Two finders use it: the hub's own (below xl) and the
 * rail's (xl and up; it lives in the settings layout and outlives every navigation). Neither keeps a second copy.
 *
 * The query lives on its own history entry, so Back/Forward brings it back and a fresh visit starts empty. The router
 * rewrites an entry's history state when it restores it, which can drop the key, so the last query also lives in module
 * scope (it survives a finder unmounting or clearing on a navigation), and a popstate (Back/Forward) that lands on the
 * settings hub marks the next recall as a return rather than a fresh visit.
 */
const HISTORY_KEY = "rfSettingsQuery";

let lastQuery = "";
let returning = false;
let handoff: string | null = null;

/** The bare settings hub (`/settings`, not a sub-page). */
export function isSettingsHub(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/settings";
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    // Only a Back/Forward that LANDS on the hub is a return to it. One that lands anywhere else (another page, a
    // settings sub-page) must not leave the flag armed for a later, unrelated fresh visit to /settings.
    returning = isSettingsHub(window.location.pathname);
  });
}

/** What a Back/Forward that landed on the hub hands over (read once per return; see below), else "". */
function fromReturn(): string {
  if (returning) {
    // read once per return; a finder and the hub (or a dev-mode double mount) recall in the same tick, so the
    // value is handed on until the microtask below
    returning = false;
    handoff = lastQuery;
    queueMicrotask(() => {
      handoff = null;
    });
    return lastQuery;
  }
  return handoff ?? "";
}

/**
 * The query a finder shows when it MOUNTS on the hub: the one its history entry kept (a reload of the entry), or what
 * a Back/Forward that landed here hands over, else "" (a fresh visit: the memory is dropped).
 */
export function recallSettingsQuery(): string {
  const kept = (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY];
  const restored = (typeof kept === "string" && kept ? kept : "") || fromReturn();
  if (!restored) lastQuery = "";
  return restored;
}

/**
 * The query the persistent rail shows when its location changes onto the hub. Only a Back/Forward that landed here
 * brings one back: the entry's own state is not read, because a hash or tab link on the hub is a navigation too and
 * must clear the search (SA PR1b M1). Anything else is a fresh visit: "" and the memory is dropped.
 */
export function recallReturnedQuery(): string {
  const restored = fromReturn();
  if (!restored) lastQuery = "";
  return restored;
}

/** A query the person typed: remembered, and kept on THIS history entry (only our key changes; the router's own state stays). */
export function rememberSettingsQuery(q: string): void {
  lastQuery = q;
  window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_KEY]: q }, "");
}
