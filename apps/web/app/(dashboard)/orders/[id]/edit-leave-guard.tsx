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
 * Edit Items must never lose typed edits silently. While `dirty`: a sentinel history entry is pushed once so browser
 * Back stays on the order and asks "Discard your changes?" (Keep editing is focused); a tab close/reload gets the
 * browser's own prompt; `requestLeave(proceed)` lets an in-page link ask the same question. Same shape as the counter's
 * `useCounterBackGuard`. Discard runs `onDiscard()` (drops the working copy), then walks past the sentinel and the re-push.
 */
export function useEditLeaveGuard(
  dirty: boolean,
  onDiscard: () => void,
  onNoPreviousPage: () => void,
): { requestLeave: (proceed: () => void) => boolean; dialog: React.ReactNode } {
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const live = React.useRef({ onDiscard, onNoPreviousPage });
  live.current = { onDiscard, onNoPreviousPage };

  React.useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    if (!window.history.state?.[SENTINEL]) {
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href,
      );
    }
    const onPop = () => {
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
      setPending(() => proceed);
      return true;
    },
    [dirty],
  );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      onConfirm={() => {
        const go = pending;
        setPending(null);
        live.current.onDiscard();
        go?.();
      }}
      title="Discard your changes?"
      description="You have unsaved edits to this order. If you leave now they are lost."
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      variant="danger"
    />
  );
  return { requestLeave, dialog };
}
