import * as React from "react";
import { X } from "lucide-react";
import { Button, TAP_TARGET, cn } from "@routeflow/ui/web";
import { formatReceiptMoney as money, unitWords } from "@routeflow/pricing";
import { priceUnitWord } from "@/lib/product-unit-label";
import { cartTotals } from "@/lib/counter-sale";
import type { CartUnit } from "@/lib/buyer-cart-line";
import {
  NOTE_MAX,
  canSellByCase,
  isBoxedLine,
  lineSellCount,
  lineUnitWords,
  lineSellUnit,
  registerPriceLabel,
  registerQtyLabel,
  sellUnitWord,
  typedForSellUnit,
  type TypedQty,
} from "./counter-sale-line-edit";
import { qtyRefusalMessage, type QtyFieldKind } from "./counter-qty-refusal";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { CounterLinePriceEdit, type CounterPriceEdit } from "./CounterLinePriceEdit";
import { cartStrikesList, editedLineFigures, priceEditLineOf } from "./counter-sale-price-edit";

// A boxed line prints the default pack word (its product's own when it has one); a plain line prints its product's own unit (row 298), else the default base word.
const UW = unitWords();

/**
 * One visual weight per role (W-717). The stepper is the ONE primary control on a line: a bordered pill, bigger than any
 * other. Add / Edit / Clear note are quiet text links (the same `link` Button as Reset price), and remove is a ghost icon
 * button. Every one is still a full 44 px target (TAP_TARGET) on touch widths, however quiet it looks.
 */
const STEP_BTN = cn(
  TAP_TARGET,
  "px-3 text-lg font-semibold text-navy hover:bg-navy/5 disabled:cursor-not-allowed disabled:opacity-40",
);
const QUIET_BTN = "min-h-[44px] px-2 text-xs lg:min-h-0";
const SELL_BY_BTN = cn(TAP_TARGET, "px-2 text-xs disabled:cursor-not-allowed disabled:opacity-40");

/**
 * A TYPED quantity field, the stepper's middle. The draft is local: Enter / blur commit it, Escape reverts, and a value the
 * screen refuses (not whole, or nothing left) snaps back to the line's quantity AND says why (CQ-12), until the next edit.
 * The refusal text lives in the parent (it sits under the stepper, not inside it).
 */
function QtyField({
  label,
  kind,
  value,
  locked,
  onCommit,
  onEnter,
  refusal,
  setRefusal,
  messageId,
}: {
  label: string;
  kind: QtyFieldKind;
  value: number;
  locked: boolean;
  onCommit: (text: string) => boolean;
  onEnter?: () => void;
  refusal: string | null;
  setRefusal: (message: string | null) => void;
  messageId: string;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null); // accepted or refused, the field re-reads the line
    setRefusal(onCommit(text) ? null : qtyRefusalMessage(text, kind));
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={label}
      aria-invalid={refusal ? true : undefined}
      aria-describedby={refusal ? messageId : undefined}
      className="min-h-[44px] w-14 border-x border-navy/20 bg-transparent px-1 text-center text-sm font-semibold tabular-nums text-navy disabled:opacity-40"
      disabled={locked}
      value={draft ?? String(value)}
      onChange={(e) => {
        setRefusal(null);
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        // Tab is redirected only to finish an uncommitted typed edit; a plain Tab moves on normally
        if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && draft !== null)) {
          e.preventDefault();
          commit();
          onEnter?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setRefusal(null);
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * Row 676 (SA-831b M13, the row-531 rule): ONE stepper that counts the line's SELLING UNIT - [ - count + ] - with the unit
 * always named beside it ("2 cases", "27 each"). A boxed line also shows a Box / Each toggle (the buyer cart's Case / Each):
 * Box steps and types whole boxes, Each steps and types pieces, and the split is re-derived by `stepLine` / `setLineQty`
 * (`normalizeBoxesPieces`) exactly as before, so a typed 27 each is "1 box + 3 pcs" either way. Nothing steps a line to zero
 * (x removes it). The unit the clerk picked sticks until they pick the other.
 */
function LineQuantity({
  line,
  locked,
  onStep,
  onQty,
  onEnter,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onQty: (tempId: string, typed: TypedQty) => boolean;
  onEnter?: () => void;
}) {
  const [chosen, setChosen] = React.useState<CartUnit | undefined>(undefined);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const messageId = React.useId();
  const boxed = isBoxedLine(line);
  const unit = lineSellUnit(line, chosen);
  const count = lineSellCount(line, unit);
  const word = sellUnitWord(line, unit, count, UW);
  const stepUnit: StepUnit = boxed && unit === "CASE" ? "box" : "piece";
  const step = (dir: 1 | -1) => {
    setChosen(unit);
    setRefusal(null);
    onStep(line.tempId, stepUnit, dir);
  };
  const stepBtn = (label: string, text: string, dir: 1 | -1) => (
    <button
      type="button"
      className={STEP_BTN}
      aria-label={label}
      disabled={locked || stepLine(line, stepUnit, dir) === line}
      onClick={() => step(dir)}
    >
      {text}
    </button>
  );
  const name = line.name;
  const words = lineUnitWords(line, UW);
  const caseBlocked = unit !== "CASE" && !canSellByCase(line);
  const pick = (next: CartUnit) => {
    setChosen(next);
    setRefusal(null);
  };
  const sellBy = (
    next: CartUnit,
    text: string,
    label: string,
    disabled = false,
    title?: string,
  ) => (
    <button
      type="button"
      className={cn(
        SELL_BY_BTN,
        unit === next ? "font-semibold text-navy" : "text-navy/60 hover:text-navy",
      )}
      aria-pressed={unit === next}
      aria-label={label}
      disabled={locked || disabled}
      title={title}
      onClick={() => pick(next)}
    >
      {text}
    </button>
  );
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="inline-flex items-stretch overflow-hidden rounded-lg border border-navy/40"
          role="group"
          aria-label={`Quantity of ${name}`}
        >
          {stepBtn(
            boxed
              ? unit === "CASE"
                ? `Remove a box from ${name}`
                : `Remove a piece from ${name}`
              : `Remove one ${name}`,
            "\u2212",
            -1,
          )}
          <QtyField
            key={unit}
            kind={!boxed ? "qty" : unit === "CASE" ? "boxes" : "pieces"}
            label={
              !boxed
                ? `Set quantity of ${name}`
                : unit === "CASE"
                  ? `Boxes of ${name}`
                  : `Pieces of ${name}`
            }
            value={count}
            locked={locked}
            onCommit={(t) => {
              setChosen(unit);
              return onQty(line.tempId, typedForSellUnit(line, unit, t));
            }}
            onEnter={onEnter}
            refusal={refusal}
            setRefusal={setRefusal}
            messageId={messageId}
          />
          {stepBtn(
            boxed
              ? unit === "CASE"
                ? `Add a box to ${name}`
                : `Add a piece to ${name}`
              : `Add one ${name}`,
            "+",
            1,
          )}
        </span>
        <span className="text-xs text-navy/70" data-testid="line-sell-unit">
          {count} {word}
        </span>
        {boxed ? (
          <span className="inline-flex items-center" role="group" aria-label={`Sold by, ${name}`}>
            {sellBy(
              "CASE",
              words.pack.one,
              `Sell ${name} by the ${words.pack.lower}`,
              caseBlocked,
              caseBlocked
                ? `Set whole ${words.pack.lowerOther} to sell by the ${words.pack.lower}.`
                : undefined,
            )}
            {sellBy("EACH", "Each", `Sell ${name} by the each`)}
          </span>
        ) : null}
      </span>
      {refusal ? (
        <span
          id={messageId}
          role="alert"
          className="basis-full text-xs text-red-700"
          data-testid="counter-qty-refusal"
        >
          {refusal}
        </span>
      ) : null}
    </>
  );
}

/**
 * One cart line. Top row: name + quantity label, subtotal, remove. Below: the stepper and the note. `locked` disables EVERY
 * control on the line (an unknown outcome, or the sale POST in flight).
 */
/** R7b 1.4: the one sentence (a line and the Payment area both say it; the server refusal at Complete stays authoritative). */
export const COUNTER_LICENSE_NOTE = "Needs a licensed customer: choose one before paying";

export function CounterLineRow({
  line: l,
  locked,
  onStep,
  onRemove,
  onNote,
  needsLicense,
  onQty,
  canEditPrices = false,
  priceTier = 1,
  customerName,
  onPriceEdit,
  onPriceReset,
  onPriceClosed,
  onNoteClosed,
  onQtyEnter,
  hideOriginalPrice = false,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
  onNote: (tempId: string, note: string) => void;
  /** R7b 1.4: a walk-in sale holds a line that needs a licensed customer: show the one amber note on the line. */
  needsLicense?: boolean;
  onQty: (tempId: string, typed: TypedQty) => boolean;
  /** POS-5: the ONE gate (`staffMay(role, "EDIT_LINE_PRICE")`). False = the price control does not exist (hidden, never disabled). */
  canEditPrices?: boolean;
  /** POS-5: the customer's pricing tier for this product (a special tier needs a reason for a real change) */
  priceTier?: number;
  customerName?: string;
  onPriceEdit?: (tempId: string, edit: CounterPriceEdit) => void;
  onPriceReset?: (tempId: string) => void;
  onPriceClosed?: () => void;
  /** The note field closed (Enter, Escape, Clear note or the toggle): the screen re-arms the scan field (SA-762r #8). */
  onNoteClosed?: () => void;
  /** Enter on a typed quantity: the screen hands focus back to the scan field. */
  onQtyEnter?: () => void;
  /** The tenant's `invoice.hideOriginalPrice` (`GET /settings`): no struck catalogue price, as on the receipt. */
  hideOriginalPrice?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const noteAtOpenRef = React.useRef(""); // Escape puts the note back to what it was when the field opened
  const closeNote = () => {
    setEditing(false);
    onNoteClosed?.();
  };
  const hasNote = !!l.note?.trim();
  const edited = editedLineFigures(l, hideOriginalPrice);
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">
          {l.name} · {registerQtyLabel(l, UW)}
          <span className="block text-xs text-navy/70">
            {cartStrikesList(l, hideOriginalPrice) ? (
              <s className="mr-1 tabular-nums text-navy/50" data-testid="line-unit-price-was">
                {money(l.listPrice ?? l.unitPrice)}
              </s>
            ) : null}
            <span className="tabular-nums" data-testid="line-unit-price">
              {registerPriceLabel(l, UW, money, priceUnitWord)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {edited?.original != null ? (
            <s className="text-xs text-navy/60" data-testid="line-original-total">
              {money(edited.original)}
            </s>
          ) : null}
          <span data-testid={edited ? "line-net-total" : undefined}>
            {money(cartTotals([l], 0).subtotal)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] min-w-[44px] px-0"
            aria-label={`Remove ${l.name}`}
            disabled={locked}
            onClick={() => onRemove(l.tempId)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LineQuantity line={l} locked={locked} onStep={onStep} onQty={onQty} onEnter={onQtyEnter} />
        <CounterLinePriceEdit
          canEditPrices={canEditPrices}
          name={l.name}
          line={priceEditLineOf(l, priceTier)}
          edited={!!l.override}
          customerName={customerName}
          locked={locked}
          onApply={(edit) => onPriceEdit?.(l.tempId, edit)}
          onReset={() => onPriceReset?.(l.tempId)}
          onClosed={onPriceClosed}
        />
        {edited ? (
          <span
            className="rounded bg-navy/5 px-2 py-1 text-xs text-navy"
            data-testid="line-price-chip"
          >
            {edited.chip}
          </span>
        ) : null}
        <Button
          type="button"
          variant="link"
          size="sm"
          className={QUIET_BTN}
          aria-label={`${hasNote ? "Edit the note on" : "Add a note to"} ${l.name}`}
          aria-expanded={editing}
          disabled={locked}
          onClick={() => {
            if (editing) return closeNote();
            noteAtOpenRef.current = l.note ?? "";
            setEditing(true);
          }}
        >
          {hasNote ? "Edit note" : "Add note"}
        </Button>
        {hasNote ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className={QUIET_BTN}
            aria-label={`Clear the note on ${l.name}`}
            disabled={locked}
            onClick={() => {
              onNote(l.tempId, "");
              closeNote();
            }}
          >
            Clear note
          </Button>
        ) : null}
      </div>
      {editing ? (
        <input
          type="text"
          maxLength={NOTE_MAX}
          aria-label={`Note for ${l.name}`}
          className="min-h-[44px] w-full text-ellipsis rounded border px-2 py-1 text-sm"
          placeholder="Flavor or note for this item (prints on invoice)"
          disabled={locked}
          value={l.note ?? ""}
          onChange={(e) => onNote(l.tempId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              closeNote(); // saved (each keystroke already is): close and re-arm the scan field
            } else if (e.key === "Escape") {
              e.preventDefault();
              onNote(l.tempId, noteAtOpenRef.current);
              closeNote();
            }
          }}
          onBlur={(e) => {
            // Focus lost to nowhere (a click on blank space): save, close, back to the scan box. Moving to another
            // control on purpose is left alone.
            if (e.relatedTarget === null) closeNote();
          }}
          data-counter-note=""
          autoFocus // opening the note puts the cursor in it: the next keys are the note, never a page shortcut
        />
      ) : hasNote ? (
        <p className="break-words text-xs text-navy/70" data-testid="line-note">
          {l.note}
        </p>
      ) : null}
      {needsLicense ? (
        <p className="text-xs text-amber-800" data-testid="line-license-note">
          {COUNTER_LICENSE_NOTE}
        </p>
      ) : null}
    </li>
  );
}
