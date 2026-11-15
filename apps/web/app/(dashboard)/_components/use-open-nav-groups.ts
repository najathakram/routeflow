import * as React from "react";
import { defaultOpenGroup, type NavEntry, type NavGroup } from "./nav-config";

/**
 * Which sidebar groups are open (UX guide improvement 1).
 *
 * - `multi` (the desktop rail): any number of groups stay open. The remembered set (per user on this
 *   device, `rf-nav-open:{userId}`) holds only what the person opened or closed by clicking, plus the
 *   first-load default (Warehouse, pin kept) while nothing is stored. A group is shown open when it is
 *   remembered or holds the active page; merely navigating through a group never remembers it. Only a
 *   toggle writes (UXG-R2 amendment 2026-11-15).
 * - `single` (the phone drawer): today's accordion, one group at a time, nothing stored.
 *
 * Storage read or write failures fall back to the in-memory set and never throw.
 */
export type NavGroupMode = "multi" | "single";

const keyFor = (userId: string | null | undefined) => (userId ? `rf-nav-open:${userId}` : null);

function readStored(key: string | null): string[] | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

function writeStored(key: string | null, open: string[]) {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(open));
  } catch {
    /* storage full or blocked: keep the in-memory set */
  }
}

export function useOpenNavGroups({
  nav,
  pathname,
  userId,
  mode,
}: {
  nav: NavEntry[];
  pathname: string;
  userId: string | null | undefined;
  mode: NavGroupMode;
}): { isOpen: (label: string) => boolean; toggle: (label: string) => void } {
  const storageKey = mode === "multi" ? keyFor(userId) : null;
  const activeGroupLabel =
    nav.find(
      (e): e is NavGroup =>
        e.kind === "group" && e.children.some((c) => pathname.startsWith(c.href)),
    )?.label ?? null;

  // multi: what the person opened by clicking (plus the first-load default while nothing is stored);
  // single: the one open group, which follows navigation.
  const initial = (): string[] => {
    if (mode === "multi") {
      const remembered = readStored(storageKey);
      if (remembered) return remembered;
      // The group holding the page is open anyway, so the default only matters with no active group.
      const def = activeGroupLabel ? null : defaultOpenGroup(nav, pathname);
      return def ? [def] : [];
    }
    const def = defaultOpenGroup(nav, pathname);
    return def ? [def] : [];
  };
  const [open, setOpen] = React.useState<string[]>(initial);

  // A different person on the same device: load their set.
  // The effect reads the latest closure through a ref, so its only dependency is the key.
  const initialRef = React.useRef(initial);
  initialRef.current = initial;
  const lastKey = React.useRef(storageKey);
  React.useEffect(() => {
    if (lastKey.current === storageKey) return;
    lastKey.current = storageKey;
    setOpen(initialRef.current());
  }, [storageKey]);

  // The phone drawer is an accordion that follows navigation. The rail does not: a group the person
  // only passed through is shown open while it holds the page (isOpen) and is never remembered.
  React.useEffect(() => {
    if (mode !== "single" || !activeGroupLabel) return;
    setOpen([activeGroupLabel]);
  }, [activeGroupLabel, mode]);

  const isOpen = React.useCallback(
    (label: string) => open.includes(label) || (mode === "multi" && label === activeGroupLabel),
    [open, mode, activeGroupLabel],
  );

  const toggle = React.useCallback(
    (label: string) => {
      setOpen((cur) => {
        if (mode === "single") return cur.includes(label) ? [] : [label];
        // Toggle what is on screen: the group holding the page counts as open, so clicking it
        // removes a (possibly absent) remembered entry and never stores it.
        const shownOpen = cur.includes(label) || label === activeGroupLabel;
        const next = shownOpen ? cur.filter((l) => l !== label) : [...cur, label];
        writeStored(storageKey, next);
        return next;
      });
    },
    [mode, storageKey, activeGroupLabel],
  );

  return { isOpen, toggle };
}
