import * as React from "react";
import { defaultOpenGroup, type NavEntry, type NavGroup } from "./nav-config";

/**
 * Which sidebar groups are open (UX guide improvement 1).
 *
 * - `multi` (the desktop rail): any number of groups stay open and the set is remembered per user
 *   on this device (`rf-nav-open:{userId}`). Navigating into a group opens it. With nothing
 *   remembered the set is `defaultOpenGroup` (the first-load Warehouse pin is kept). Only a toggle
 *   writes, so a first visit still shows the default until the person chooses.
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

  const initial = (): string[] => {
    const remembered = readStored(storageKey);
    if (remembered)
      return activeGroupLabel ? [...new Set([...remembered, activeGroupLabel])] : remembered;
    const def = defaultOpenGroup(nav, pathname);
    return def ? [def] : [];
  };
  const [open, setOpen] = React.useState<string[]>(initial);

  // A different person on the same device: load their set.
  const lastKey = React.useRef(storageKey);
  React.useEffect(() => {
    if (lastKey.current === storageKey) return;
    lastKey.current = storageKey;
    setOpen(initial());
  }, [storageKey]);

  // Navigating into a group opens it (single mode: and closes the rest, as the accordion did).
  React.useEffect(() => {
    if (!activeGroupLabel) return;
    setOpen((cur) =>
      mode === "single"
        ? [activeGroupLabel]
        : cur.includes(activeGroupLabel)
          ? cur
          : [...cur, activeGroupLabel],
    );
  }, [activeGroupLabel, mode]);

  const toggle = React.useCallback(
    (label: string) => {
      setOpen((cur) => {
        const next =
          mode === "single"
            ? cur.includes(label)
              ? []
              : [label]
            : cur.includes(label)
              ? cur.filter((l) => l !== label)
              : [...cur, label];
        if (mode === "multi") writeStored(storageKey, next);
        return next;
      });
    },
    [mode, storageKey],
  );

  const isOpen = React.useCallback((label: string) => open.includes(label), [open]);
  return { isOpen, toggle };
}
