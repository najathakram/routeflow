import * as React from "react";
import { parseQuantityExpression } from "@routeflow/pricing";

/** SA-1256: the most a typed sum may work out to (the API's own cap on qty, boxes and pieces). */
export const SUM_QTY_MAX = 100_000;
export const SUM_QTY_COPY = {
  invalid: "Sum not valid. Quantity not changed.",
  empty: "Sum not valid. Quantity not changed.",
  "not-whole": "Not a whole number. Not changed.",
  "too-big": "Too big. The most is 100,000.",
  belowOne: "Must be at least 1. Not changed.",
} as const;

/** The note takes a line of its own under the boxes and adds no width, so the box being typed in never moves. */
const NOTE = "order-last -ml-1 w-0 min-w-full whitespace-nowrap text-[10px]";

/** The box's own handlers, exactly as it has them without sums: digits (and an emptied box) still go through these. */
export interface PlainQtyField {
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
}

interface SumQtyOptions {
  /** The number the box holds for the line. */
  committed: number;
  /** Takes a worked-out sum, an arrow step, or the number being put back. */
  commit: (n: number) => void;
  plain: PlainQtyField;
  /** A sum below this is refused (1 for a plain quantity, 0 for boxes and pieces). */
  min: number;
  /** Arrow steps stop here (the pieces box: one less than a full pack). Typing is not capped by it. */
  stepMax?: number;
  disabled?: boolean;
  /** The line's whole quantity when the box holds only part of it (boxes or pieces): held text drops when it moves. */
  line?: string;
}

/**
 * SA-1256 typed sums PR 1: `5*2` in a quantity box works out to 10. Opt-in (`on`), the order builder's main list only.
 * Digits, and an emptied box, go through the box's own handler keystroke by keystroke, as before. Any other text is
 * held with no commit until Enter, Tab or blur, then worked out once and committed as one whole number. A sum that
 * cannot be used puts back the number the box had at focus (or the last one Enter settled since) and says why; Esc
 * does the same without a message. Held text is dropped, with nothing committed, when the line's quantity moves under
 * it or the box locks. Enter on held text is kept from the form, so Ctrl+Enter never creates from a part-typed sum.
 */
export function useSumQty(on: boolean | undefined, o: SumQtyOptions) {
  const { committed, commit, plain, min, stepMax, disabled, line } = o;
  const [held, setHeld] = React.useState<string | null>(null);
  // `at`: the number put back with the message. The message shows only while the box still holds it.
  const [refused, setRefused] = React.useState<{ text: string; at: number } | null>(null);
  // A ref as well as state: an Enter's commit clears it before the blur that follows can read it again.
  const heldRef = React.useRef<string | null>(null);
  // What a refused sum or Esc puts back: the number at focus, or the last one Enter settled since.
  const atFocus = React.useRef(committed);
  const put = (text: string | null) => {
    heldRef.current = text;
    setHeld(text);
  };
  React.useEffect(() => {
    heldRef.current = null;
    setHeld(null);
  }, [committed, disabled, line]);
  // A refusal note belongs to the number it put back: once the line holds another number it is gone for good.
  React.useEffect(() => {
    setRefused((r) => (r && r.at !== committed ? null : r));
  }, [committed]);
  if (!on) return { input: null, note: null };

  const putBack = () => {
    // An emptied box shows "" while the line already holds the number: put it back through the box's handler too.
    if (committed !== atFocus.current || String(plain.value) !== String(atFocus.current))
      commit(atFocus.current);
  };
  /** True when there was held text (worked out, or refused). */
  const flush = (): boolean => {
    const text = heldRef.current;
    if (text === null) return false;
    put(null);
    const r = parseQuantityExpression(text, { max: SUM_QTY_MAX, whole: true });
    if (r.ok && r.value >= min) {
      atFocus.current = r.value;
      commit(r.value);
      return true;
    }
    const why = r.ok ? (min >= 1 ? "belowOne" : "invalid") : r.reason;
    setRefused({ text: SUM_QTY_COPY[why], at: atFocus.current });
    putBack();
    return true;
  };
  const preview =
    held === null ? null : parseQuantityExpression(held, { max: SUM_QTY_MAX, whole: true });
  return {
    /** Spread LAST on the `<input>`: it replaces the type, the value and the change, focus, blur and key handlers. */
    input: {
      type: "text",
      inputMode: "numeric",
      role: "spinbutton",
      "aria-valuenow": committed,
      ...(held === null ? null : { "data-qty-held": "", "aria-valuetext": held }),
      value: held ?? plain.value,
      onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
        atFocus.current = committed;
        e.target.select();
      },
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setRefused(null);
        if (/^\d*$/.test(e.target.value)) {
          put(null);
          plain.onChange(e);
        } else put(e.target.value);
      },
      onBlur: () => {
        flush();
        plain.onBlur?.();
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          if (flush()) e.preventDefault();
          else atFocus.current = committed;
        } else if (e.key === "Escape") {
          if (heldRef.current === null) return;
          put(null);
          putBack();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const next = committed + (e.key === "ArrowUp" ? 1 : -1);
          if (heldRef.current === null && next >= min && next <= (stepMax ?? SUM_QTY_MAX))
            commit(next);
        }
      },
    } as const,
    note:
      refused?.at === committed ? (
        <span role="alert" className={`${NOTE} text-amber-700`}>
          {refused.text}
        </span>
      ) : preview?.ok && preview.value >= min ? (
        <span role="status" className={`${NOTE} text-navy/70`}>
          = {preview.value} · press Enter
        </span>
      ) : null,
  };
}
