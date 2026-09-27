"use client";

import * as React from "react";
import { CheckCircle2, Copy } from "lucide-react";

const DEFAULT_CLASS =
  "inline-flex items-center gap-1 rounded-ctl border border-surface-border px-2 py-1 text-xs text-navy/70 transition-colors hover:border-brand-400 hover:text-brand-600";

/**
 * Copy one value to the clipboard, showing "Copied" briefly. Each button owns its own `copied`
 * state, so two on one card never flip together (#2438: the create-tenant card shared one flag
 * between the temp password and the payment link). Lifted from SendingDomainCard's local CopyBtn.
 *
 * `className` replaces the default (light-surface) styling, e.g. for the dark back office.
 */
export function CopyButton({
  value,
  label = "Copy value",
  className,
}: {
  value: string;
  /** Accessible name, e.g. "Copy payment link". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
      className={className ?? DEFAULT_CLASS}
      aria-label={label}
    >
      {copied ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
