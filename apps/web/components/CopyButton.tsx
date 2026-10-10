"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Copy } from "lucide-react";

const DEFAULT_CLASS =
  "inline-flex items-center gap-1 rounded-ctl border border-surface-border px-2 py-1 text-xs text-navy/70 transition-colors hover:border-brand-400 hover:text-brand-600";

type Status = "idle" | "copied" | "failed";

/**
 * Copy one value to the clipboard. Each button owns its own status, so two on one card never flip
 * together (#2438: the create-tenant card shared one flag between the temp password and the payment
 * link). Lifted from SendingDomainCard's local CopyBtn.
 *
 * "Copied" shows ONLY after the clipboard write resolves. A missing Clipboard API or a rejected
 * write shows `failedText` and, when `selectOnFail` is given, selects that element's text so the
 * user can copy it by hand — never a false "Copied" that leaves the PREVIOUS clipboard value (for a
 * pay link, possibly another tenant's) to be pasted into an email (#2598 review). The status text is
 * announced politely to screen readers.
 *
 * `className` replaces the default (light-surface) styling, e.g. for the dark back office.
 */
export function CopyButton({
  value,
  label = "Copy value",
  className,
  failedText = "Copy failed — select it manually",
  selectOnFail,
}: {
  value: string;
  /** Accessible name, e.g. "Copy payment link". */
  label?: string;
  className?: string;
  /** Shown when the copy fails, e.g. "Copy failed — select the link". */
  failedText?: string;
  /** The element holding the value as text, selected when the copy fails. */
  selectOnFail?: React.RefObject<HTMLElement | null>;
}) {
  const [status, setStatus] = React.useState<Status>("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const show = (next: Status, ms: number) => {
    if (!mounted.current) return;
    setStatus(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (mounted.current) setStatus("idle");
    }, ms);
  };

  const selectTarget = () => {
    const el = selectOnFail?.current;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      show("copied", 1200);
    } catch {
      selectTarget();
      show("failed", 4000);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className={className ?? DEFAULT_CLASS}
      aria-label={label}
    >
      {status === "copied" ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      ) : status === "failed" ? (
        <AlertTriangle className="h-3.5 w-3.5 text-danger" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span aria-live="polite">
        {status === "copied" ? "Copied" : status === "failed" ? failedText : "Copy"}
      </span>
    </button>
  );
}
