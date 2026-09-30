"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import type { BlockedLine } from "@routeflow/types";
import { restrictionReasonText } from "@/lib/api/selling-restricted";

/**
 * Why an order can't go through: the lines the selling-restrictions check blocked, each with a
 * plain-language cause. Shown instead of a raw error toast (the code is in providers.tsx's
 * HANDLED_CODES), so a blocked save produces exactly this one message.
 */
export function BlockedLinesDialog({
  lines,
  onClose,
}: {
  lines: BlockedLine[] | null;
  onClose: () => void;
}) {
  // Opened by an error handler, so Radix has no trigger to return focus to: without this, closing
  // (Esc / OK) drops focus on <body> and the Create Order modal underneath loses its place.
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  // A trigger that disables itself while its request is in flight (`loading`) is blurred by the
  // browser BEFORE the 409 arrives, so by the time this opens `activeElement` is <body>. Track the
  // last element that actually held focus outside a dialog and fall back to it.
  const lastFocused = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.closest('[role="dialog"]')) lastFocused.current = t;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  return (
    <Modal
      open={!!lines}
      onClose={onClose}
      // A long blocked list must not push its OK button off-screen. The body is a plain list (no
      // inline dropdowns), so the opt-in scroll cap cannot clip anything here.
      scroll
      onOpenAutoFocus={() => {
        const active = document.activeElement as HTMLElement | null;
        returnFocusTo.current = active && active !== document.body ? active : lastFocused.current;
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
      title="Some items can't be sold to this customer"
      description="Remove them from the order to continue."
      footer={<Button onClick={onClose}>OK</Button>}
    >
      <ul className="space-y-3" aria-label="Blocked items">
        {(lines ?? []).map((l) => (
          <li
            key={`${l.productId}-${l.ruleId ?? l.reason}`}
            className="rounded-lg border border-surface-border p-3"
          >
            <p className="font-medium text-navy">{l.productName}</p>
            {l.categoryName && <p className="text-xs text-navy/60">{l.categoryName}</p>}
            <p className="mt-1 text-sm text-danger">{restrictionReasonText(l)}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
