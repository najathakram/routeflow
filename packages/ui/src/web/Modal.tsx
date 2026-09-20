"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /**
   * Radix's Escape interception point. Its Escape listener is a document-level,
   * capture-phase native listener that runs BEFORE any React handler, so
   * `stopPropagation` on a descendant can't cancel it — this prop is the only place
   * a consumer can `event.preventDefault()` to keep the dialog open (e.g. to scope
   * Escape to an inner sub-flow). Optional/opt-in — omit for the default dismiss.
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /**
   * Radix focus hooks, opt-in. A modal opened with no Radix trigger (e.g. by an error handler)
   * has nothing to return focus to on close, so focus falls to <body>; a consumer captures the
   * previously focused element in `onOpenAutoFocus` and restores it (after `preventDefault()`)
   * in `onCloseAutoFocus`.
   */
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export const Modal = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  onEscapeKeyDown,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: ModalProps) => (
  <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <Dialog.Content
        onEscapeKeyDown={onEscapeKeyDown}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn(
          // Centred with -translate-y-1/2, so an over-tall dialog used to spill off BOTH edges and take
          // its header X and footer buttons out of reach (body scroll is locked). Cap the height;
          // the header and footer stay put and only the body scrolls.
          "fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white p-6 shadow-modal",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
          "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
          className,
        )}
      >
        {/* Header */}
        <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <Dialog.Title className="text-lg font-semibold text-navy">{title}</Dialog.Title>
            ) : (
              <Dialog.Title className="sr-only">Dialog</Dialog.Title>
            )}
            {description ? (
              <Dialog.Description className="mt-1 text-sm text-navy/70">
                {description}
              </Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">Modal dialog</Dialog.Description>
            )}
          </div>
          {/* No onClick — Dialog.Close triggers onOpenChange which calls onClose via Root */}
          <Dialog.Close
            className="ml-auto flex-shrink-0 rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
        </div>

        {/* Body */}
        {/* -mx-1/px-1 keeps a focus ring at the edge from being clipped by the scroll box */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 text-sm text-navy/80">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="mt-6 flex shrink-0 items-center justify-end gap-3 border-t border-surface-border pt-4">
            {footer}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
