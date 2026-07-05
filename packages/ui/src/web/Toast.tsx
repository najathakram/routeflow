"use client";

import * as React from "react";
import * as RadixToast from "@radix-ui/react-toast";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "./utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastAction {
  /** Button label, e.g. "Undo". */
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  /** Optional action button (e.g. the 8-second Undo). */
  action?: ToastAction;
}

// ─── Variant config ───────────────────────────────────────────────────────────
// Ledger toast: white card + colored icon tile (not a colored background).

const VARIANT_CONFIG: Record<ToastVariant, { icon: () => React.ReactNode; tile: string }> = {
  success: {
    icon: () => <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
    tile: "bg-success-bg",
  },
  error: {
    icon: () => <XCircle className="h-3.5 w-3.5 text-danger" />,
    tile: "bg-danger-bg",
  },
  warning: {
    icon: () => <AlertTriangle className="h-3.5 w-3.5 text-warning" />,
    tile: "bg-warning-bg",
  },
  info: {
    icon: () => <Info className="h-3.5 w-3.5 text-info" />,
    tile: "bg-info-bg",
  },
};

// ─── Context ──────────────────────────────────────────────────────────────────

interface ToastContextValue {
  /** Show a toast; returns its id so it can be dismissed early (e.g. on Undo). */
  toast: (data: Omit<ToastData, "id">) => string;
  /** Dismiss a toast by id. */
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = React.useCallback((data: Omit<ToastData, "id">): string => {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { ...data, id }]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast, dismiss: removeToast }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => {
          const config = VARIANT_CONFIG[t.variant ?? "info"] ?? VARIANT_CONFIG.info;
          return (
            <RadixToast.Root
              key={t.id}
              duration={t.duration ?? 4000}
              onOpenChange={(open) => !open && removeToast(t.id)}
              className={cn(
                "flex items-start gap-3 rounded-card border border-line bg-paper p-3.5 shadow-dropdown",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full",
                "data-[state=open]:slide-in-from-top-full",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded",
                  config.tile,
                )}
              >
                {config.icon()}
              </span>
              <div className="flex-1 min-w-0">
                <RadixToast.Title className="text-[13px] font-semibold text-ink-900">
                  {t.title}
                </RadixToast.Title>
                {t.description && (
                  <RadixToast.Description className="mt-0.5 text-[12.5px] text-ink-500">
                    {t.description}
                  </RadixToast.Description>
                )}
                {t.action && (
                  <RadixToast.Action altText={t.action.label} asChild>
                    <button
                      onClick={t.action.onClick}
                      className="mt-2 text-[12.5px] font-semibold text-accent-deep hover:underline"
                    >
                      {t.action.label}
                    </button>
                  </RadixToast.Action>
                )}
              </div>
              <RadixToast.Close
                className="flex-shrink-0 rounded p-0.5 text-ink-400 hover:text-navy transition-colors"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
