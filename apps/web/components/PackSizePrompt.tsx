"use client";

/**
 * Shared inline pack-size prompt for the product create/edit forms (WP2 of
 * the in-app pack-size plan). Reads the single shared, refusal-first parser
 * in `@routeflow/types` and never overrides its judgement:
 *
 *  - HIGH / MEDIUM confidence — "Looks like this is sold in a box of N.
 *    Set pack size?" pre-filled with the parsed count; one click accepts.
 *  - AMBIGUOUS — two (or more) distinct counts read from the name. States
 *    the conflict and asks which one is the box. Pre-fills NOTHING — never
 *    guesses between them.
 *  - LOW — a quiet "How many pieces in a box?" with an empty input.
 *  - PIECE_UNIT, no suggestion, or `unitsPerBox` already a real pack size
 *    (> 1) — renders nothing. A piece-priced row must never be turned boxed
 *    by a prompt.
 *
 * This component only surfaces the suggestion and reports back the operator-
 * confirmed value via `onAccept` — it does not call any mutation itself, so
 * the value flows through whichever product create/update mutation the
 * caller's form already uses (no new endpoint). Dismissing is local to the
 * mount; editing the name/unit enough to change the underlying suggestion
 * re-opens it.
 */

import * as React from "react";
import { X } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { formatCountList, suggestPackSize } from "@routeflow/types";
import { perUnitPrice } from "@/lib/pricing";

export interface PackSizePromptProps {
  /** Product name — the parser reads candidate counts out of this. */
  name?: string | null;
  /** Selling unit (e.g. "each", "case", "12pk") — drives PACKISH_UNIT / PIECE_UNIT. */
  unit?: string | null;
  /** Per-unit SKU, if distinct from the case SKU — a HIGH-confidence signal. */
  unitSku?: string | null;
  /**
   * Current `unitsPerBox` value as the surrounding form stores it (string or
   * number — forms here keep it as a string draft). Blank/0/null — and 1,
   * which the parser treats as "not boxed" — all count as "unset". Once it
   * holds a real pack size (> 1), the prompt never shows.
   */
  unitsPerBox?: string | number | null;
  /**
   * The row's current per-selling-unit price, if known. Used ONLY to preview
   * what the price becomes PER PIECE if this suggestion is accepted (via the
   * shared `perUnitPrice` display helper) — accepting re-bases the stored
   * price's meaning from per-piece to per-case, and the operator must see
   * that number before committing, not after saving. Never written anywhere
   * by this component; omit it to render without the preview line.
   */
  unitPrice?: number | null;
  /**
   * The product's on-hand quantity, when this is an EXISTING product. Setting
   * `unitsPerBox` RE-DENOMINATES stored numbers rather than converting them:
   * the codebase reads `currentStock` as base units and `averageCost` as
   * per-piece once a product is boxed (see `costPerSellingUnit`). So a row
   * holding 50 CASES becomes 50 pieces, and an $8.00 case cost reads as
   * $8.00 per piece. Pass this so the prompt can say so out loud; omit it on
   * a create form, where there is nothing yet to re-denominate.
   */
  currentStock?: number | null;
  /** Called with the operator-confirmed pack size; write it into your own draft/mutation. */
  onAccept: (value: number) => void;
  className?: string;
}

function toPositiveNumber(v: string | number | null | undefined): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Accepts only a whole number > 1 — a "pack of 1" or "pack of 0" is not a pack. */
function parseAcceptableCount(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = parseInt(raw, 10);
  return n > 1 && n <= 1000 ? n : null;
}

export function PackSizePrompt({
  name,
  unit,
  unitSku,
  unitsPerBox,
  unitPrice,
  currentStock,
  onAccept,
  className,
}: PackSizePromptProps) {
  const currentUnitsPerBox = toPositiveNumber(unitsPerBox);

  const suggestion = React.useMemo(
    () => suggestPackSize({ name, unit, unitSku, unitsPerBox: currentUnitsPerBox }),
    [name, unit, unitSku, currentUnitsPerBox],
  );

  const [dismissed, setDismissed] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState<string>(
    suggestion.packSize != null ? String(suggestion.packSize) : "",
  );

  // Re-seed (and re-open) only when the underlying suggestion actually
  // changes — e.g. the operator edits the name and a different count (or a
  // second, ambiguous one) becomes readable. A no-op re-render must not
  // silently clear an operator's own edit to the number field.
  const suggestionKey = `${suggestion.confidence ?? "none"}:${suggestion.packSize ?? ""}:${suggestion.counts.join(",")}`;
  const prevSuggestionKey = React.useRef(suggestionKey);
  React.useEffect(() => {
    if (prevSuggestionKey.current === suggestionKey) return;
    prevSuggestionKey.current = suggestionKey;
    setDraftValue(suggestion.packSize != null ? String(suggestion.packSize) : "");
    setDismissed(false);
  }, [suggestionKey, suggestion.packSize]);

  // Nothing to suggest, a piece-unit row, or dismissed ⇒ nothing. "Already
  // set" is deliberately NOT re-derived here: `suggestPackSize` already
  // returns `confidence: null` for that, and only for `unitsPerBox > 1`. A
  // stored 1 means "not boxed" and must still prompt — same rule as
  // `shouldPromptPackSize` and mobile's `packSizePromptFor`.
  if (!suggestion.confidence || suggestion.confidence === "PIECE_UNIT") return null;
  if (dismissed) return null;

  const isAmbiguous = suggestion.confidence === "AMBIGUOUS";
  const isConfident = suggestion.confidence === "HIGH" || suggestion.confidence === "MEDIUM";
  const acceptableValue = parseAcceptableCount(draftValue);

  // Preview of what the price becomes PER PIECE if the operator accepts —
  // driven by whatever count is currently typed/pre-filled, so it tracks the
  // input live and stays blank (never a guess) while AMBIGUOUS/LOW hasn't
  // been resolved to a real count yet.
  const perPiecePreview =
    acceptableValue != null && unitPrice != null ? perUnitPrice(unitPrice, acceptableValue) : null;

  const handleAccept = () => {
    if (acceptableValue == null) return;
    onAccept(acceptableValue);
  };

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-brand-800">
          {isAmbiguous ? (
            <>
              This name mentions {suggestion.counts.length} different counts (
              {formatCountList(suggestion.counts)}). Which one is a box?
            </>
          ) : isConfident ? (
            <>
              Looks like this is sold in a box of <strong>{suggestion.packSize}</strong>. Set pack
              size?
            </>
          ) : (
            "How many pieces in a box?"
          )}
        </p>
        {isAmbiguous && (
          <p className="mt-0.5 text-[11px] text-brand-700/80">
            We never guess between them — tell us which one is the box.
          </p>
        )}
        {(currentStock ?? 0) > 0 && (
          // Setting a pack size RE-DENOMINATES rather than converts: the stored
          // on-hand number starts being read as pieces, and the stored cost as
          // per-piece. If this product's stock was counted in cases, both become
          // wrong by the pack size. Say it plainly here — the operator is the
          // only one who knows which unit that 50 was counted in.
          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            This product already holds <strong>{currentStock}</strong> in stock. Setting a pack size
            makes that number, and the recorded cost, read as <em>pieces</em> — so if it was counted
            in cases, adjust stock and cost afterwards.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min={2}
            max={1000}
            step={1}
            inputMode="numeric"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder={isConfident ? undefined : "e.g. 12"}
            aria-label="Units per box"
            className="w-24 rounded border border-brand-300 bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={acceptableValue == null}
            onClick={handleAccept}
          >
            Set pack size
          </Button>
        </div>
        {perPiecePreview != null && (
          <p className="mt-1 text-[11px] text-brand-700/80">
            That&rsquo;s ≈ ${perPiecePreview.toFixed(2)} / unit at the current price of $
            {Number(unitPrice).toFixed(2)}.
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="Dismiss"
        aria-label="Dismiss pack-size suggestion"
        className="rounded p-1 text-brand-700/60 transition-colors hover:bg-brand-100 hover:text-brand-800"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
