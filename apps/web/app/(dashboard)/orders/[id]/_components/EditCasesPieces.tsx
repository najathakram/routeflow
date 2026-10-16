"use client";

import * as React from "react";
import { unitWords } from "@routeflow/pricing";
import { CasesPiecesInput } from "@/components/CasesPiecesInput";
import { applyCasesPieces, casesPiecesOf } from "../edit-cases-pieces";

/**
 * O1 (F06): Edit Items' quantity entry for a classic boxed line - the shared `CasesPiecesInput`
 * Create uses, wired to the edit row. Every typed value goes through `applyCasesPieces`
 * (@routeflow/pricing `normalizeBoxesPieces`), so the row stores TOTAL pieces + `boxSplit` and
 * `buildItemUpdates` sends boxes/pieces for the server to prorate.
 */
export function EditCasesPieces({
  item,
  onChange,
  children,
}: {
  item: { qty: number; unitsPerBox?: number | null; boxSplit?: boolean };
  /** The line patch to merge (qty + boxSplit + startOnDefaultUnit). */
  onChange: (patch: NonNullable<ReturnType<typeof applyCasesPieces>>) => void;
  /** Rendered after the control (the scan split hint). */
  children?: React.ReactNode;
}) {
  const current = casesPiecesOf(item);
  const set = (next: { boxes: number; pieces: number }) => {
    const patch = applyCasesPieces(item, next);
    if (patch) onChange(patch);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <CasesPiecesInput
        boxes={current.boxes}
        pieces={current.pieces}
        unitsPerBox={Number(item.unitsPerBox)}
        words={unitWords()}
        onSetBoxes={(n) => set({ boxes: n, pieces: current.pieces })}
        onSetPieces={(n) => set({ boxes: current.boxes, pieces: n })}
      />
      {children}
    </div>
  );
}
