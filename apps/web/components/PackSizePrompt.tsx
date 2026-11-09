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
import { perUnitPrice, unitWords } from "@routeflow/pricing";

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
   * The product's on-hand quantity, when this is an EXISTING product. Stock reads as pieces and cost as per-piece
   * once a product is boxed (see `costPerSellingUnit`), so the save asks what this number was counted in (SA-961 R1).
   * Pass this so the prompt can say so; omit it on a create form, where there is nothing to ask about.
   */
  currentStock?: number | null;
  /** Called with the operator-confirmed pack size; write it into your own draft/mutation. */
  onAccept: (value: number) => void;
  /**
   * K12 O1: the count the operator TYPED here but has not confirmed with "Set pack size" (null when nothing typed, the
   * value is not a valid pack, the prompt is dismissed or gone). The form's own Save must send it: dropping typed input
   * behind a "Saved" is the one thing this prompt must never do. A pre-filled suggestion never counts until typed.
   */
  onPendingChange?: (value: number | null) => void;
  /**
   * "card" (default) is the boxed prompt with its own count input. "helper" is for a form that already has its own
   * Units per box field (W-1170 F12b): the same parser and the same never-guess rules, rendered as helper text under
   * that field, so the pack size is asked in one place. HIGH/MEDIUM offer the count with a one-click "Use N",
   * AMBIGUOUS states the conflict and offers nothing, LOW and PIECE_UNIT render nothing (the field itself asks).
   */
  variant?: "card" | "helper";
  /** The helper's id, so the form can point the field's aria-describedby at it. */
  id?: string;
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
  onPendingChange,
  variant = "card",
  id,
  className,
}: PackSizePromptProps) {
  const currentUnitsPerBox = toPositiveNumber(unitsPerBox);

  const suggestion = React.useMemo(
    () => suggestPackSize({ name, unit, unitSku, unitsPerBox: currentUnitsPerBox }),
    [name, unit, unitSku, currentUnitsPerBox],
  );

  const [dismissed, setDismissed] = React.useState(false);
  /** The operator typed in the box (a pre-filled suggestion alone is never a pending value). */
  const [typed, setTyped] = React.useState(false);
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
    setTyped(false);
    setDismissed(false);
  }, [suggestionKey, suggestion.packSize]);

  const visible = !!suggestion.confidence && suggestion.confidence !== "PIECE_UNIT" && !dismissed;
  const pending = visible && typed ? parseAcceptableCount(draftValue) : null;
  const reportPending = React.useRef(onPendingChange);
  reportPending.current = onPendingChange;
  React.useEffect(() => {
    reportPending.current?.(pending);
  }, [pending]);
  React.useEffect(() => () => reportPending.current?.(null), []);

  // Nothing to suggest, a piece-unit row, or dismissed ⇒ nothing. "Already
  // set" is deliberately NOT re-derived here: `suggestPackSize` already
  // returns `confidence: null` for that, and only for `unitsPerBox > 1`. A
  // stored 1 means "not boxed" and must still prompt — same rule as
  // `shouldPromptPackSize` and mobile's `packSizePromptFor`.
  if (!suggestion.confidence || suggestion.confidence === "PIECE_UNIT") return null;
  if (dismissed) return null;

  const w = unitWords();
  if (variant === "helper") {
    if (suggestion.confidence === "AMBIGUOUS") {
      return (
        <p id={id} className={cn("text-[11px] text-navy/70", className)}>
          This name mentions {suggestion.counts.length} different counts (
          {formatCountList(suggestion.counts)}). Enter the one that is a {w.pack.lower}.
        </p>
      );
    }
    if (suggestion.confidence === "LOW" || suggestion.packSize == null) return null;
    const n = suggestion.packSize;
    return (
      <p id={id} className={cn("text-[11px] text-navy/70", className)}>
        Looks like {n} per {w.pack.lower}.{" "}
        <button
          type="button"
          onClick={() => onAccept(n)}
          className="font-medium text-accent-deep underline underline-offset-[3px] hover:no-underline"
        >
          {`Use ${n}`}
        </button>
      </p>
    );
  }
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
              {formatCountList(suggestion.counts)}). Which one is a {w.pack.lower}?
            </>
          ) : isConfident ? (
            <>
              Looks like this is sold in a {w.pack.lower} of <strong>{suggestion.packSize}</strong>.
              Set pack size?
            </>
          ) : (
            `How many ${w.base.lowerOther} in a ${w.pack.lower}?`
          )}
        </p>
        {isAmbiguous && (
          <p className="mt-0.5 text-[11px] text-brand-700/80">
            We never guess between them — tell us which one is the {w.pack.lower}.
          </p>
        )}
        {(currentStock ?? 0) > 0 && (
          // The operator is the only one who knows which unit that 50 was counted in.
          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            This product already holds <strong>{currentStock}</strong> in stock. When you save,
            we&apos;ll ask whether that number is boxes or pieces.
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
            onChange={(e) => {
              setDraftValue(e.target.value);
              setTyped(true);
            }}
            placeholder={isConfident ? undefined : "e.g. 12"}
            aria-label={`${w.base.other} per ${w.pack.lower}`}
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
