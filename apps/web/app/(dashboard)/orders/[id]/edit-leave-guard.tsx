"use client";

import * as React from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const SENTINEL = "__rfEditLeaveSentinel";

/** The fields of an edit line a person can change; display-only state (pickers, hints) never counts as an edit. */
const EDIT_FIELDS = [
  "id",
  "productId",
  "qty",
  "unitPrice",
  "cancelled",
  "notes",
  "overrideReason",
  "substituteProductId",
  "unitLabel",
  "boxSplit",
  "unitsPerBox",
] as const;

function fingerprint(
  items: ReadonlyArray<Record<string, unknown>>,
  pendingDeletes: ReadonlyArray<string>,
  shippingFee: number,
  creditsTouched: boolean,
): string {
  return JSON.stringify([
    items.map((it) => EDIT_FIELDS.map((k) => it[k] ?? null)),
    [...pendingDeletes].sort(),
    Number(shippingFee) || 0,
    creditsTouched,
  ]);
}

/** True when the Edit Items working copy differs from the lines it was opened with (row 604 F24 / row 699a). */
export function isEditDirty(
  seed: { items: ReadonlyArray<object>; shippingFee: number },
  current: {
    items: ReadonlyArray<object>;
    pendingDeletes: ReadonlyArray<string>;
    shippingFee: number;
    creditsTouched: boolean;
  },
): boolean {
  return (
    fingerprint(seed.items as Record<string, unknown>[], [], seed.shippingFee, false) !==
    fingerprint(
      current.items as Record<string, unknown>[],
      current.pendingDeletes,
      current.shippingFee,
      current.creditsTouched,
    )
  );
}

/**
 * The address a click would leave this page for, or null when the click is not a leave: not a plain left click, not
 * on a link, a new tab or a download, another site (the browser's own unload prompt covers that), or the page itself
 * (a hash or a same-page link).
 */
export function leavingHref(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return null;
  const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return null;
  let url: URL;
  try {
    url = new URL(anchor.getAttribute("href") ?? "", window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === window.location.pathname && url.search === window.location.search)
    return null;
  return url.pathname + url.search + url.hash;
}

/**
 * Edit Items must never lose typed edits silently. While `dirty`: a sentinel history entry is pushed once so browser
 * Back stays on the order and asks "Discard your changes?" (Keep editing is focused); a tab close/reload gets the
 * browser's own prompt; `requestLeave(proceed)` lets an in-page link ask the same question. Same shape as the counter's
 * `useCounterBackGuard`. Discard runs `onDiscard()` (drops the working copy), then walks past the sentinel and the re-push.
 *
 * A click on any link that leaves the page (the side menu, a breadcrumb, a row link) is asked the same question
 * (UX audit 2026-11-24 F03: a typed price was lost by one click on "Customers" with no prompt). The hook listens on
 * the document in the capture phase, so no link on the page has to be wired by hand and none can be forgotten.
 * `options.what` names the record in the dialog ("order", "product"); `options.navigate` is the page's router push,
 * used to follow the link after Discard (without it the browser loads the address).
 */
export function useEditLeaveGuard(
  dirty: boolean,
  onDiscard: () => void,
  onNoPreviousPage: () => void,
  options: { what?: string; navigate?: (href: string) => void } = {},
): { requestLeave: (proceed: () => void) => boolean; dialog: React.ReactNode } {
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const what = options.what ?? "order";
  const live = React.useRef({ onDiscard, onNoPreviousPage, navigate: options.navigate });
  live.current = { onDiscard, onNoPreviousPage, navigate: options.navigate };
  const wasDirty = React.useRef(false);
  const popping = React.useRef(false);
  const viaLink = React.useRef(false);
  /**
   * The history steps this guard took itself (walking off its sentinel). `history.back()` lands later, as its own
   * event; if the form is dirty again by then (the person typed back to the saved value and on past it), that
   * event must not be read as the person pressing Back.
   */
  const ownPops = React.useRef(new WeakSet<Event>());

  /** Row 604 S2: walk off the extra sentinel entry once, so the next Back goes where the person expects. */
  const popSentinel = React.useCallback((then?: () => void) => {
    if (popping.current || !window.history.state?.[SENTINEL]) return false;
    popping.current = true;
    window.addEventListener(
      "popstate",
      (e) => {
        popping.current = false;
        ownPops.current.add(e);
        then?.();
      },
      { once: true },
    );
    window.history.back();
    return true;
  }, []);

  React.useEffect(() => {
    // Declared before the listener effect: React runs all cleanups first, so `onPop` is already detached here.
    if (wasDirty.current && !dirty && typeof window !== "undefined") popSentinel();
    wasDirty.current = dirty;
  }, [dirty, popSentinel]);

  React.useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    if (!window.history.state?.[SENTINEL]) {
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href,
      );
    }
    const pushSentinel = () =>
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href,
      );
    const onPop = (e: PopStateEvent) => {
      if (popping.current) return;
      if (ownPops.current.has(e)) {
        // Our own step off the sentinel landed after the form went dirty again: no question, and put the sentinel
        // back so a real Back is still asked.
        if (!window.history.state?.[SENTINEL]) pushSentinel();
        return;
      }
      viaLink.current = false;
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href,
      );
      setPending(() => () => {
        window.removeEventListener("popstate", onPop);
        if (window.history.length < 3) live.current.onNoPreviousPage();
        else window.history.go(-2);
      });
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);

  const requestLeave = React.useCallback(
    (proceed: () => void) => {
      if (!dirty) return false;
      viaLink.current = true;
      setPending(() => proceed);
      return true;
    },
    [dirty],
  );

  // Links: while dirty, a plain left click on an <a> that goes to another page asks first.
  React.useEffect(() => {
    if (!dirty || typeof document === "undefined") return;
    const onClick = (e: MouseEvent) => {
      const href = leavingHref(e);
      if (href === null) return;
      e.preventDefault();
      e.stopPropagation();
      viaLink.current = true;
      setPending(() => () => {
        if (live.current.navigate) live.current.navigate(href);
        else window.location.assign(href);
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      onConfirm={() => {
        const go = pending;
        setPending(null);
        live.current.onDiscard();
        if (go && viaLink.current && popSentinel(go)) return;
        go?.();
      }}
      title="Discard your changes?"
      description={`You have unsaved edits to this ${what}. If you leave now they are lost.`}
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      variant="danger"
    />
  );
  return { requestLeave, dialog };
}

/**
 * The order page's guard: with no previous page, Back goes to the orders list; after Discard a clicked link is
 * followed through the page's router. Kept here so the order page (at its size limit) carries one line for it.
 */
export function useOrderEditLeaveGuard(
  dirty: boolean,
  onDiscard: () => void,
  router: { push: (href: string) => void },
) {
  return useEditLeaveGuard(dirty, onDiscard, () => router.push("/orders"), {
    navigate: (href) => router.push(href),
  });
}
