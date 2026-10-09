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
   * Radix pointer/focus-outside interception, opt-in: `event.preventDefault()` keeps the dialog
   * open on an outside click (e.g. a long form that must not be discarded by a stray click).
   */
  onInteractOutside?: (event: Event) => void;
  /**
   * Radix focus hooks, opt-in. A modal opened with no Radix trigger (e.g. by an error handler)
   * has nothing to return focus to on close, so focus falls to <body>; a consumer captures the
   * previously focused element in `onOpenAutoFocus` and restores it (after `preventDefault()`)
   * in `onCloseAutoFocus`.
   */
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /**
   * Opt-in: cap the dialog at 92vh, pin the header (with its X) and the footer, and scroll only the
   * body. Without it the dialog is centred with `-translate-y-1/2` and no max height, so one taller
   * than the viewport spills off BOTH edges and its X and footer buttons become unreachable (body
   * scroll is locked). Off by default so existing dialogs are untouched.
   *
   * DO NOT enable it on a dialog whose body contains absolutely-positioned children, such as an
   * inline typeahead or dropdown list (`absolute … top-full`): the body becomes a scroll container,
   * which CLIPS them (and adds a scrollbar just for the open list). Portal those first, or leave
   * `scroll` off. Prove any dialog you opt in at a short viewport.
   */
  scroll?: boolean;
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
  onInteractOutside,
  onOpenAutoFocus,
  onCloseAutoFocus,
  scroll = false,
}: ModalProps) => {
  const contentRef = React.useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          ref={contentRef}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={(event) => {
            // A dropdown list portalled to <body> (data-anchored-list) is part of THIS dialog only
            // when its anchor lives here: the list is stamped with the owning dialog's id.
            const list =
              event.target instanceof Element ? event.target.closest("[data-anchored-list]") : null;
            const id = contentRef.current?.id;
            if (list && id && list.getAttribute("data-anchored-owner") === id) {
              event.preventDefault();
              return;
            }
            onInteractOutside?.(event);
          }}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-modal",
            scroll && "flex max-h-[92vh] flex-col",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
            className,
          )}
        >
          {/* Header */}
          <div className={cn("mb-4 flex items-start justify-between gap-4", scroll && "shrink-0")}>
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
          <div
            className={cn(
              "text-sm text-navy/80",
              // -mx-1/px-1: a focus ring at the edge is not clipped by the scroll box
              scroll && "-mx-1 min-h-0 flex-1 overflow-y-auto px-1",
            )}
          >
            {children}
          </div>

          {/* Footer */}
          {footer && (
            <div
              className={cn(
                "mt-6 flex items-center justify-end gap-3 border-t border-surface-border pt-4",
                scroll && "shrink-0",
              )}
            >
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
