import * as React from "react";

/**
 * SA-1066 A-3: where the till's "Drafts (n)" button is portaled. The till header row renders an empty
 * `<DraftDockSlot />` (components/DraftDockSlot.tsx) that registers its element here; the draft dock, mounted once in the
 * dashboard layout and far from the till in the tree, reads the element and portals the button into it. A tiny external
 * store rather than a `getElementById` lookup or a context, because the two sit in different subtrees and the slot
 * mounts after the dock has rendered: `useSyncExternalStore` re-renders the dock the moment the slot appears or goes.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The slot's ref callback: the element on mount, null on unmount. Re-registering the same element is a no-op. */
export function registerDraftDockSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The registered slot element, or null while no till header is mounted. Server and first render read null. */
export function useDraftDockSlot(): HTMLElement | null {
  return React.useSyncExternalStore(
    subscribe,
    () => slot,
    () => null,
  );
}
