"use client";

import * as React from "react";
import * as RadixToast from "@radix-ui/react-toast";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "./utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastData {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

// ─── Variant config ───────────────────────────────────────────────────────────

const VARIANT_CONFIG: Record<ToastVariant, { icon: () => React.ReactNode; classes: string }> = {
  success: {
    icon: () => <CheckCircle2 className="h-5 w-5 text-success" />,
    classes: "border-success/20 bg-success-bg",
  },
  error: {
    icon: () => <XCircle className="h-5 w-5 text-danger" />,
    classes: "border-danger/20 bg-danger-bg",
  },
  warning: {
    icon: () => <AlertTriangle className="h-5 w-5 text-warning" />,
    classes: "border-warning/20 bg-warning-bg",
  },
  info: {
    icon: () => <Info className="h-5 w-5 text-brand-500" />,
    classes: "border-brand-100 bg-brand-50",
  },
};

// ─── Context ──────────────────────────────────────────────────────────────────

interface ToastContextValue {
  toast: (data: Omit<ToastData, "id">) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);

  const addToast = React.useCallback((data: Omit<ToastData, "id">) => {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { ...data, id }]);
  }, []);

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => {
          const config = VARIANT_CONFIG[t.variant ?? "info"];
          return (
            <RadixToast.Root
              key={t.id}
              duration={t.duration ?? 4000}
              onOpenChange={(open) => !open && removeToast(t.id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-4 shadow-dropdown",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full",
                "data-[state=open]:slide-in-from-top-full",
                config.classes,
              )}
            >
              <span className="mt-0.5 flex-shrink-0">{config.icon()}</span>
              <div className="flex-1 min-w-0">
                <RadixToast.Title className="text-sm font-semibold text-navy">
                  {t.title}
                </RadixToast.Title>
                {t.description && (
                  <RadixToast.Description className="mt-1 text-xs text-navy/70">
                    {t.description}
                  </RadixToast.Description>
                )}
              </div>
              <RadixToast.Close
                className="flex-shrink-0 rounded p-0.5 text-navy/40 hover:text-navy transition-colors"
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
