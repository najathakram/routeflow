"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import type { SellLevel } from "@routeflow/pricing";
import {
  CounterLiveMatches,
  useCounterLiveMatches,
} from "../../orders/_components/CounterLiveMatches";
import { useScanCodeHandler } from "../../orders/_components/scan/useScanCodeHandler";

/**
 * "Scan or type to add items" for Create purchase order: the till's live match list and the shared scan
 * resolver. Enter with text is a scan (adds one entry unit); Enter on an arrowed row adds that row; Enter
 * never submits the order. The caller owns the lines (`onAdd`).
 */
export function PurchaseOrderScanBar({
  onAdd,
  hasLine,
  addedIds,
  disabled = false,
  hint,
  onRetry,
}: {
  /** `level` is what the scanned code carries (absent for a name pick). */
  onAdd: (product: any, level?: SellLevel) => { created: boolean; refused?: boolean };
  disabled?: boolean;
  hint?: string;
  /** Shown beside the hint as "Try again" (a failed catalog read). */
  onRetry?: () => void;
  hasLine: (productId: string) => boolean;
  addedIds: ReadonlySet<string>;
}) {
  const { toast } = useToast();
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const lastCode = React.useRef("");
  const [note, setNote] = React.useState("");
  const add = (product: any, level?: SellLevel) => {
    const r = onAdd(product, level);
    if (r.refused) {
      // A family is a container: keep what was typed and say what to do.
      setText(lastCode.current);
      setNote(`Pick a flavour: ${product.name} has variants`);
    } else {
      setText("");
      setNote("");
    }
    inputRef.current?.focus();
    return r;
  };
  const live = useCounterLiveMatches({ text, enabled: true, onPick: (p) => add(p), addedIds });
  const scanRef = useScanCodeHandler({
    addLineItem: (product, level) => add(product, level),
    onUnknownCode: (code) =>
      toast({
        variant: "error",
        title: `No product has the code ${code}`,
        description: "Search for it by name.",
      }),
    hasLine,
    toast,
  });
  return (
    <div className="mb-3">
      <input
        ref={inputRef}
        name="po-scan"
        aria-label="Scan or type to add items"
        placeholder="Scan or type to add items"
        autoComplete="off"
        className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        {...live.nav.inputProps}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setNote("");
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (live.nav.onKeyDown(e)) return;
          if (e.key !== "Enter") return;
          e.preventDefault(); // never submits the order
          const code = text.trim();
          if (!code) return;
          lastCode.current = code;
          setText("");
          void scanRef.current(code);
        }}
      />
      {(hint || note) && (
        <p role="status" className="mt-1 text-xs text-navy/70">
          {hint ?? note}
          {hint && onRetry && (
            <>
              {" "}
              <button
                type="button"
                onClick={onRetry}
                className="font-medium text-brand-600 underline"
              >
                Try again
              </button>
            </>
          )}
        </p>
      )}
      <CounterLiveMatches live={live} onPick={(p) => add(p)} />
    </div>
  );
}
