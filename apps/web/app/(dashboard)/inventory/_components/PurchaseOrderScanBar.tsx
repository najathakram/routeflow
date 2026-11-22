"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
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
}: {
  onAdd: (product: any) => { created: boolean; refused?: boolean };
  hasLine: (productId: string) => boolean;
  addedIds: ReadonlySet<string>;
}) {
  const { toast } = useToast();
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const add = (product: any) => {
    const r = onAdd(product);
    setText("");
    inputRef.current?.focus();
    return r;
  };
  const live = useCounterLiveMatches({ text, enabled: true, onPick: add, addedIds });
  const scanRef = useScanCodeHandler({
    addLineItem: (product) => add(product),
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (live.nav.onKeyDown(e)) return;
          if (e.key !== "Enter") return;
          e.preventDefault(); // never submits the order
          const code = text.trim();
          if (!code) return;
          setText("");
          void scanRef.current(code);
        }}
      />
      <CounterLiveMatches live={live} onPick={add} />
    </div>
  );
}
