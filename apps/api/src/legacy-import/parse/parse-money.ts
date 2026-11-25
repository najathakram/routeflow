import { isWholeCents } from "@routeflow/pricing";

// Strict number reads for the legacy-import parsers (SA-1295 A2 C4, T55). This is NOT
// import/parse-import-number.ts and never calls it: that reader is lenient on purpose.

export type NumberRefusal =
  | "EMPTY"
  | "NOT_A_NUMBER"
  | "TOO_MANY_DECIMALS"
  | "TRAILING_SIGN"
  | "EXPONENT"
  | "NOT_FINITE"
  | "NOT_WHOLE_CENTS";

export type NumberParse = { ok: true; value: number } | { ok: false; reason: NumberRefusal };

const EXPONENT = /^[\s$+()-]*[\d.,]*\d[\d.,]*[eE][+-]?\d+\)?$/;
const TRAILING_SIGN = /[\d.][+-]$/;
const BODY = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/;
const MAX_CENTS_VALUE = Number.MAX_SAFE_INTEGER / 100;

function parseStrict(raw: string, maxDecimals: number): NumberParse {
  let s = raw.trim();
  if (s === "") return { ok: false, reason: "EMPTY" };
  if (EXPONENT.test(s)) return { ok: false, reason: "EXPONENT" };
  if (TRAILING_SIGN.test(s)) return { ok: false, reason: "TRAILING_SIGN" };

  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  const lead = /^([+-]?)\$?(.*)$/.exec(s);
  if (!lead) return { ok: false, reason: "NOT_A_NUMBER" };
  if (lead[1] === "-") negative = true;
  s = lead[2];

  const body = BODY.exec(s);
  if (!body || (body[1] === undefined && body[2] === undefined)) {
    return { ok: false, reason: "NOT_A_NUMBER" };
  }
  const decimals = body[2]?.length ?? 0;
  if (decimals > maxDecimals) return { ok: false, reason: "TOO_MANY_DECIMALS" };

  const digits = `${(body[1] ?? "0").replace(/,/g, "")}.${body[2] ?? "0"}`;
  const magnitude = Number(digits);
  if (!Number.isFinite(magnitude)) return { ok: false, reason: "NOT_FINITE" };
  const value = negative ? -magnitude : magnitude;
  return { ok: true, value: value === 0 ? 0 : value };
}

/**
 * A money cell: at most 2 decimals, no trailing sign, no exponent, parentheses mean negative,
 * thousands commas and a leading "$" allowed. Never rounds a refused value into acceptance.
 */
export function parseMoney(raw: string): NumberParse {
  const r = parseStrict(raw, 2);
  if (!r.ok) return r;
  if (Math.abs(r.value) > MAX_CENTS_VALUE || !isWholeCents(r.value)) {
    return { ok: false, reason: "NOT_WHOLE_CENTS" };
  }
  return r;
}

/** A quantity cell: same grammar, up to 4 decimals, negative allowed. */
export function parseQuantity(raw: string): NumberParse {
  return parseStrict(raw, 4);
}
