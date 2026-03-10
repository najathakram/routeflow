"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Modal = ({ open, onClose, title, children, footer, className }: ModalProps) => (
  <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <Dialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-modal",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
          "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
          className,
        )}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-4">
          {title && (
            <Dialog.Title className="text-lg font-semibold text-navy">
              {title}
            </Dialog.Title>
          )}
          <Dialog.Close
            onClick={onClose}
            className="ml-auto rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
        </div>

        {/* Body */}
        <div className="text-sm text-navy/80">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="mt-6 flex items-center justify-end gap-3 border-t border-surface-border pt-4">
            {footer}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
