"use client";

import * as React from "react";

interface AdminModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Take the initial focus instead of the first focusable (e.g. a confirm dialog's primary action). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Phone width: a bottom sheet (about 80% height, scrolling inside); from `sm` up it is the usual centred dialog. */
  sheet?: boolean;
  /** `alertdialog` for a destructive confirm that interrupts the admin (BO-05: "Stop billing for N add-ons?"). */
  role?: "dialog" | "alertdialog";
  /** The id of the element that describes the dialog (an alert dialog's body). */
  describedBy?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AdminModal({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusRef,
  sheet,
  role = "dialog",
  describedBy,
}: AdminModalProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  // The latest onClose, read at call time. Callers pass an inline arrow (`() => setX(null)`), a NEW
  // function on every parent render; with `onClose` in the effect's dependency list, each keystroke
  // in a controlled field inside the modal re-ran the effect: cleanup focused the trigger, then the
  // body moved focus to the first focusable (the close button), so typing was cut off after one
  // character (A3 F9). The effect now depends on `open` alone.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  React.useEffect(() => {
    if (!open) return;

    triggerRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const initialFocusable =
      initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (initialFocusable ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      triggerRef.current?.focus?.();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center ${sheet ? "items-end sm:items-center" : "items-center"}`}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`relative w-full max-w-lg rounded-xl bg-slate-800 ring-1 ring-white/10 shadow-2xl ${
          sheet ? "max-h-[80vh] overflow-y-auto rounded-b-none sm:max-h-[90vh] sm:rounded-b-xl" : ""
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
          <h3 id={titleId} className="text-base font-semibold text-white">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="inline-flex h-11 w-11 items-center justify-center text-lg leading-none text-slate-400 hover:text-white"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-slate-700 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
