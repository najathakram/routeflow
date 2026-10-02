"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";

/**
 * The order-edit Add Item / Scan row: the search-or-scan field plus the shared scanner button
 * (camera + wedge). Extracted verbatim from orders/[id]/page.tsx (size ratchet, #2715 PR-1);
 * behaviour unchanged — the page keeps the state and the one resolve path (handleScanCode).
 */
export function EditScanBar({
  inputRef,
  value,
  loading,
  pricingReady,
  onChange,
  onFocus,
  onEnter,
  onEscape,
  onScan,
  onError,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  loading: boolean;
  pricingReady: boolean;
  onChange: (value: string) => void;
  onFocus: () => void;
  onEnter: () => void;
  onEscape: () => void;
  onScan: (code: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2">
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-400" />
      ) : (
        <Search className="h-4 w-4 shrink-0 text-brand-400" />
      )}
      <input
        ref={inputRef}
        type="text"
        placeholder="Scan barcode or type name…"
        value={value}
        disabled={!pricingReady}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onKeyDown={(e) => {
          // #2715 PR-1: the scanner button's wedge detector already handled (and
          // preventDefault'd) a scan's Enter — standing down keeps ONE scan to ONE add.
          if (e.defaultPrevented) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onEnter();
          } else if (e.key === "Escape") {
            onEscape();
          }
        }}
        className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/70 outline-none"
      />
      <BarcodeScannerButton
        inputRef={inputRef}
        onScan={onScan}
        onError={onError}
        className="h-9 min-h-[44px] w-9 min-w-[44px] shrink-0"
        title="Scan barcode"
      />
      {!pricingReady && (
        // shrink-0 + whitespace-nowrap keep this row exactly as tall as it is
        // without the hint (ux-spec: no layout jump); below sm only the spinner
        // shows, so the label can never wrap the row open on a phone.
        <span className="flex shrink-0 items-center gap-1 text-xs text-navy/70">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="sr-only whitespace-nowrap sm:not-sr-only">
            Loading customer pricing…
          </span>
        </span>
      )}
    </div>
  );
}
