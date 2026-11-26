/**
 * SA-1256 typed sums: reads a sum typed into a quantity box ("5*2", "2+3", "(2+3)*4") and works it out.
 *
 * Hand-written on purpose: no dynamic evaluation and no built-in number parsing, so nothing but a sum can
 * get through. It accepts ASCII digits, `+ - * /`, brackets, `x` and `×` for times, and spaces between
 * them. A leading sign, a number next to a bracket with no operator, a decimal point, a thousands
 * separator and an exponent are all refused. The arithmetic is exact (whole-number fractions in lowest
 * terms), so `10/3*3` is 10 and `1/49*49` is 1. Under `whole`, a result that is not a whole number is
 * refused, never rounded. It never throws.
 *
 * The result may be below zero (`2-5`): the box that asked owns its own minimum.
 */
export const QUANTITY_EXPRESSION_MAX_LENGTH = 32;

export type QuantityExpressionRefusal = "empty" | "invalid" | "not-whole" | "too-big";
export type QuantityExpressionResult =
  { ok: true; value: number } | { ok: false; reason: QuantityExpressionRefusal };

export interface QuantityExpressionOptions {
  /** The largest result allowed; anything above is refused as "too-big". */
  max: number;
  /** Refuse a result that is not a whole number. */
  whole: boolean;
}

/** numerator, denominator: denominator above zero, lowest terms. */
type Fraction = readonly [number, number];

const gcd = (a: number, b: number): number => {
  let [x, y] = [Math.abs(a), Math.abs(b)];
  while (y) [x, y] = [y, x % y];
  return x;
};
/** A product that is no longer exact becomes NaN, which `fraction` refuses. */
const times = (a: number, b: number): number => {
  const p = a * b;
  return Number.isSafeInteger(p) ? p : NaN;
};

export function parseQuantityExpression(
  text: string,
  { max, whole }: QuantityExpressionOptions,
): QuantityExpressionResult {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (text.length > QUANTITY_EXPRESSION_MAX_LENGTH) return { ok: false, reason: "invalid" };

  let at = 0;
  let refusal: QuantityExpressionRefusal = "invalid";
  const next = (): string | undefined => {
    while (text[at] === " ") at++;
    return text[at];
  };
  const fraction = (n: number, d: number): Fraction | null => {
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) {
      refusal = "too-big";
      return null;
    }
    const g = gcd(n, d) * (d < 0 ? -1 : 1);
    return [n / g + 0, d / g]; // `+ 0`: never a negative zero
  };
  const number = (): Fraction | null => {
    let n = 0;
    const from = at;
    for (let c = text.charCodeAt(at) - 48; c >= 0 && c <= 9; c = text.charCodeAt(++at) - 48) {
      n = n * 10 + c;
    }
    return at === from ? null : fraction(n, 1);
  };
  const factor = (): Fraction | null => {
    if (next() !== "(") return number();
    at++;
    const inner = sum();
    if (!inner || next() !== ")") return null;
    at++;
    return inner;
  };
  const product = (): Fraction | null => {
    let left = factor();
    while (left) {
      const op = next();
      if (op !== "*" && op !== "x" && op !== "×" && op !== "/") break;
      at++;
      const right = factor();
      if (!right || (op === "/" && right[0] === 0)) return null;
      left =
        op === "/"
          ? fraction(times(left[0], right[1]), times(left[1], right[0]))
          : fraction(times(left[0], right[0]), times(left[1], right[1]));
    }
    return left;
  };
  function sum(): Fraction | null {
    let left = product();
    while (left) {
      const op = next();
      if (op !== "+" && op !== "-") break;
      at++;
      const right = product();
      if (!right) return null;
      const a = times(left[0], right[1]);
      const b = times(right[0], left[1]);
      left = fraction(op === "+" ? a + b : a - b, times(left[1], right[1]));
    }
    return left;
  }

  const result = sum();
  if (!result || next() !== undefined) return { ok: false, reason: result ? "invalid" : refusal };
  const [n, d] = result;
  if (whole && d !== 1) return { ok: false, reason: "not-whole" };
  const value = d === 1 ? n : n / d;
  return value > max ? { ok: false, reason: "too-big" } : { ok: true, value };
}
