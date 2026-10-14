"use client";

import * as React from "react";
import { Check, Package, Pencil, X } from "lucide-react";
import { Button, cn, TAP_TARGET } from "@routeflow/ui/web";

/** Batch A1: the Details card's Edit / Cancel / Save controls, with words, plus the phone-width sticky bar. */

const WORD_BUTTON = cn(
  TAP_TARGET,
  "gap-1.5 rounded px-2.5 text-navy/70 transition-[colors,transform] hover:bg-surface-raised hover:text-navy active:scale-[0.97]",
);

/** View-mode Edit. `title` stays: the e2e specs locate it by `button[title="Edit product"]`. */
export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Edit product" className={WORD_BUTTON}>
      <Pencil className="h-4 w-4" />
      <span className="text-[12.5px] font-medium">Edit</span>
    </button>
  );
}

/** Edit-mode pair, Cancel then Save. */
export function EditActionButtons({
  onCancel,
  onSave,
  saving,
  className,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <button type="button" onClick={onCancel} className={WORD_BUTTON}>
        <X className="h-4 w-4" />
        <span className="text-[12.5px] font-medium">Cancel</span>
      </button>
      <Button size="sm" onClick={onSave} loading={saving} leftIcon={<Check className="h-4 w-4" />}>
        Save
      </Button>
    </div>
  );
}

/** Below md the header pair scrolls away with the card; this keeps Cancel / Save in reach while editing. */
export function StickyEditBar({
  onCancel,
  onSave,
  saving,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div
      data-testid="sticky-edit-bar"
      className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-end gap-2 border-t border-surface-border bg-white/85 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
    >
      <Button variant="secondary" className="min-h-11 flex-1" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        className="min-h-11 flex-1"
        onClick={onSave}
        loading={saving}
        leftIcon={<Check className="h-4 w-4" />}
      >
        Save
      </Button>
    </div>
  );
}

/** After a save, bring the edited card back into view (a jump, not a glide, under reduced motion). */
export function scrollCardIntoView(el: HTMLElement | null | undefined) {
  if (!el || typeof el.scrollIntoView !== "function") return;
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
}

/** Gallery thumbnail: a broken URL falls back to the box-icon tile instead of showing alt text. */
export function ThumbImage({
  url,
  alt,
  objectPosition,
}: {
  url: string;
  alt: string;
  objectPosition?: string;
}) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [url]);
  if (broken) {
    return (
      <span
        data-testid="thumb-fallback"
        className="flex h-full w-full items-center justify-center bg-surface-raised"
      >
        <Package className="h-5 w-5 text-navy/30" aria-hidden />
        <span className="sr-only">{alt}</span>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="h-full w-full object-cover"
      style={{ objectPosition }}
      onError={() => setBroken(true)}
    />
  );
}
