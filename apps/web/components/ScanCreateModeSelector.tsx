"use client";

import * as React from "react";
import { Receipt, ShoppingCart, Sparkles } from "lucide-react";
import { cn } from "@routeflow/ui/web";

type CreateMode = "bill" | "expense" | "both";

const OPTIONS = [
  {
    value: "bill",
    label: "Vendor Bill",
    sub: "Adds to inventory and updates costs",
    icon: ShoppingCart,
  },
  {
    value: "expense",
    label: "Expense",
    sub: "Bookkeeping only — no stock change",
    icon: Receipt,
  },
  {
    value: "both",
    label: "Both",
    sub: "Inventory + bookkeeping in one go",
    icon: Sparkles,
  },
] as const;

/** "What would you like to create?" — hidden in purchase-order intent, where a scan always records
 *  a bill and its PO (an expense-only record has no PO). */
export function ScanCreateModeSelector({
  intent,
  createMode,
  onChange,
}: {
  intent: "bill" | "purchase-order";
  createMode: CreateMode;
  onChange: (mode: CreateMode) => void;
}) {
  if (intent === "purchase-order") return null;
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-navy">What would you like to create?</p>
      <div className="grid grid-cols-3 gap-3">
        {OPTIONS.map(({ value, label, sub, icon: Icon }) => (
          <button
            key={value}
            onClick={() => onChange(value)}
            className={cn(
              "flex flex-col items-start gap-1.5 rounded-xl border-2 px-4 py-3 text-left transition-all",
              createMode === value
                ? "border-brand-500 bg-brand-50 text-brand-700 shadow-sm"
                : "border-surface-border bg-white text-navy hover:border-brand-200 hover:bg-brand-50/30",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              <span className="text-sm font-semibold">{label}</span>
            </div>
            <span className="text-xs leading-snug text-current/70">{sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
