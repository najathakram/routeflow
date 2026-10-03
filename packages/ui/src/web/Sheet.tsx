"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./utils";
import { useReducedMotion } from "./motion";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  side?: "bottom" | "right" | "center";
  /** Element to focus on open; defaults to the first focusable inside. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
}

const SIDE: Record<NonNullable<SheetProps["side"]>, string> = {
  bottom: "inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
  right: "inset-y-0 right-0 w-full max-w-md",
  center: "left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl",
};

/** Focus-trapped, Escape-dismissible overlay on the same Radix primitive as `Modal`. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = "bottom",
  initialFocus,
  children,
  className,
}: SheetProps) {
  const reduced = useReducedMotion();
  // Opened from outside a Radix trigger, so remember what had focus and give it back on close.
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            opener.current = document.activeElement as HTMLElement | null;
            if (initialFocus) {
              e.preventDefault();
              initialFocus.current?.focus();
            }
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener.current?.focus();
          }}
          data-motion={reduced ? "reduced" : "full"}
          className={cn(
            "fixed z-50 flex flex-col overflow-y-auto bg-white p-4 shadow-modal",
            SIDE[side],
            className,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-navy">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-navy/60">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-navy/60 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
