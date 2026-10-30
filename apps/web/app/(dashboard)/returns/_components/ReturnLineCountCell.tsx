"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import {
  lineCountMode,
  lineUnitWords,
  type LineCountInput,
  type ReturnLineSnapshot,
} from "@/lib/return-line-qty";

/**
 * SA-1042 B9c: the count cell of one return row. The person counts what was sold in the unit it was sold in: Cases and pcs
 * on a split line, one stepper with its word on a factor-1 unit line, one input with no word on a legacy line. No
 * pieces arithmetic is asked of them; the server converts, caps and prices.
 */
const INPUT =
  "h-11 w-16 rounded border bg-white sm:h-8 px-2 text-center text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500";

export function ReturnLineCountCell({
  line,
  productName,
  value,
  onChange,
  invalid,
}: {
  line: ReturnLineSnapshot;
  productName: string;
  value: LineCountInput;
  onChange: (field: keyof LineCountInput, next: string) => void;
  invalid?: boolean;
}) {
  const mode = lineCountMode(line);
  const words = lineUnitWords(line);
  const field = (key: keyof LineCountInput, word: string | null, fraction = false) => (
    <label className="flex items-center gap-1.5 text-xs text-navy/70">
      <input
        type="number"
        inputMode={fraction ? "decimal" : "numeric"}
        min="0"
        step={fraction ? "any" : "1"}
        placeholder="0"
        aria-label={`${word ?? "Quantity"} to return, ${productName}`}
        value={value[key]}
        onChange={(e) => onChange(key, e.target.value)}
        className={cn(INPUT, invalid ? "border-danger" : "border-surface-border")}
      />
      {word && <span aria-hidden="true">{word}</span>}
    </label>
  );
  if (mode === "legacy")
    return <div className="flex flex-col gap-1">{field("qty", null, true)}</div>;
  if (mode === "unit")
    return <div className="flex flex-col gap-1">{field("boxes", words.many)}</div>;
  return (
    <div className="flex flex-col gap-1">
      {field("boxes", words.many)}
      {field("pieces", "pcs")}
    </div>
  );
}
