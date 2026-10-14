"use client";

import * as React from "react";
import { Button, Modal, Textarea } from "@routeflow/ui/web";
import {
  RESTRICTION_OVERRIDE_REASON_MAX,
  type BlockedLine,
  type RestrictionAck,
  type RestrictionWarningError,
  type RestrictionWarningLine,
} from "@routeflow/types";
import { restrictionReasonText } from "@/lib/api/selling-restricted";
import {
  RESTRICTION_COPY as COPY,
  buildAck,
  checkOverrideReason,
  driverBlockRows,
  ruleText,
} from "@/lib/api/restriction-warning";

export type RestrictionDialogView =
  | { kind: "warning"; warning: RestrictionWarningError }
  | {
      kind: "blocked";
      message: string;
      lines: BlockedLine[];
      /** Per-rule lines the server adds to the driver body: the same text and badge staff see. */
      ruleLines?: RestrictionWarningLine[];
    };

interface Props {
  /** null = closed. */
  view: RestrictionDialogView | null;
  /** A reason typed on an earlier attempt of the same save. A repeat 409 clears it (the list changed), so this is "" there. */
  initialReason?: string;
  /** A repeat 409 with a fresh list: say so in a polite live region; the reason was cleared so the user re-confirms. */
  listChanged?: boolean;
  /** "Sell anyway": the ack to resubmit with, and the trimmed reason (kept for a second 409). */
  onConfirm: (ack: RestrictionAck, reason: string) => void;
  /** "Go back" / Esc / X: nothing is sent, and the form and cart stay as they were. */
  onCancel: () => void;
}

/**
 * Row 510: the ONE staff warning. Lists the breached lines (name, outcome, rules), asks for ONE reason (3-200 characters,
 * sent for every listed line) and resolves the ack. A DRIVER, who may not override, gets the same dialog in its
 * "blocked" form: "Ask the office to approve this sale", no reason field and no override. Opened by an error handler (no
 * Radix trigger), so it hands focus back to whatever held it, like BlockedLinesDialog.
 */
export function RestrictionWarningDialog({
  view,
  initialReason = "",
  listChanged = false,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = React.useState(initialReason);
  const reasonRef = React.useRef<HTMLTextAreaElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const lastFocused = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.closest('[role="dialog"]')) lastFocused.current = t;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const warning = view?.kind === "warning" ? view.warning : null;
  const check = checkOverrideReason(reason);
  const showError = reason.length > 0 && !check.ok;
  const common = {
    open: !!view,
    onClose: onCancel,
    scroll: true,
    onOpenAutoFocus: (e: Event) => {
      const active = document.activeElement as HTMLElement | null;
      returnFocusTo.current = active && active !== document.body ? active : lastFocused.current;
      // The next step is typing a reason, so land there instead of on the X (the blocked form has no field).
      if (reasonRef.current) {
        e.preventDefault();
        reasonRef.current.focus();
      }
    },
    onCloseAutoFocus: (e: Event) => {
      const el = returnFocusTo.current;
      returnFocusTo.current = null;
      if (el && el.isConnected && el !== document.body) {
        e.preventDefault();
        el.focus();
      }
    },
  };

  if (view?.kind === "blocked") {
    return (
      <Modal
        {...common}
        title={view.message || COPY.blockedTitle}
        description={COPY.blockedBody}
        footer={
          <Button className="max-md:min-h-11" onClick={onCancel}>
            {COPY.ok}
          </Button>
        }
      >
        <ul className="space-y-3" aria-label="Blocked items">
          {(view.ruleLines ?? []).length > 0
            ? driverBlockRows(view.ruleLines ?? []).map((row) => (
                <li key={row.key} className="rounded-lg border border-surface-border p-3">
                  <p className="font-medium text-navy">{row.name}</p>
                  {row.items.map((it, i) => (
                    <p
                      key={i}
                      className="mt-1 flex flex-wrap items-center gap-2 text-sm text-danger"
                    >
                      <span>{it.text}</span>
                      {it.legal && (
                        <span className="rounded bg-danger-bg px-1.5 py-0.5 text-xs font-medium">
                          {COPY.legalBadge}
                        </span>
                      )}
                    </p>
                  ))}
                </li>
              ))
            : view.lines.map((l) => (
                <li
                  key={`${l.productId}-${l.ruleId ?? l.reason}`}
                  className="rounded-lg border border-surface-border p-3"
                >
                  <p className="font-medium text-navy">{l.productName}</p>
                  <p className="mt-1 text-sm text-danger">{restrictionReasonText(l)}</p>
                </li>
              ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      {...common}
      title={COPY.title}
      description={COPY.body}
      footer={
        <>
          {/* 44px below md (the owner's touch-target rule); desktop keeps the ledger control height. */}
          <Button variant="secondary" className="max-md:min-h-11" onClick={onCancel}>
            {COPY.goBack}
          </Button>
          <Button
            className="max-md:min-h-11"
            disabled={!check.ok}
            onClick={() => warning && check.ok && onConfirm(buildAck(warning, reason), check.value)}
          >
            {COPY.sellAnyway}
          </Button>
        </>
      }
    >
      {listChanged && (
        <p
          role="status"
          aria-live="polite"
          className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm font-medium text-navy"
        >
          {COPY.listChanged}
        </p>
      )}
      <ul className="space-y-3" aria-label="Restricted items">
        {(warning?.lines ?? []).map((l) => (
          <li key={l.lineKey} className="rounded-lg border border-surface-border p-3">
            <p className="font-medium text-navy">{l.displayName}</p>
            {l.rules.length === 0 ? (
              <p className="mt-1 text-sm text-danger">{COPY.unchecked}</p>
            ) : (
              l.rules.map((r) => (
                <p
                  key={r.id}
                  className="mt-1 flex flex-wrap items-center gap-2 text-sm text-danger"
                >
                  <span>{ruleText(r)}</span>
                  {r.legal && (
                    <span className="rounded bg-danger-bg px-1.5 py-0.5 text-xs font-medium">
                      {COPY.legalBadge}
                    </span>
                  )}
                </p>
              ))
            )}
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <Textarea
          ref={reasonRef}
          label={COPY.reasonLabel}
          placeholder={COPY.reasonPlaceholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={showError ? (check.error ?? undefined) : undefined}
          maxLength={RESTRICTION_OVERRIDE_REASON_MAX * 2}
          className="min-h-[72px]"
        />
        <p className="mt-1 text-right text-xs text-navy/60" aria-live="polite">
          {check.length}/{RESTRICTION_OVERRIDE_REASON_MAX}
        </p>
      </div>
    </Modal>
  );
}
