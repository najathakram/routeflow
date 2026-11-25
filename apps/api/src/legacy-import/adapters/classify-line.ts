import type { LineKind } from "./canonical";

export interface ClassifierInput {
  itemName: string | null;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

export interface ClassifiedLine {
  kind: LineKind;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

const SHIPPING_WORD = /\b(ship|shipping|freight|delivery|fuel|handling)\b/i;
const DISCOUNT_WORD = /\b(discount|disc|credit|adjustment|adj|rebate|promo|allowance)\b/i;

/**
 * Line kind from what the file states (T3). It never invents a quantity and never rebuilds a
 * total: the numbers are returned exactly as given.
 */
export function classifyLine(input: ClassifierInput): ClassifiedLine {
  const { itemName, description, quantity, unitPrice, total } = input;
  const numbers = { quantity, unitPrice, total };
  if (itemName !== null && itemName.trim() !== "") return { kind: "PRODUCT", ...numbers };
  if (quantity === null && unitPrice === null && total === null) {
    return { kind: "NOTE", ...numbers };
  }
  if (quantity === null && unitPrice === null && total !== null) {
    const text = description ?? "";
    if (DISCOUNT_WORD.test(text)) return { kind: "DISCOUNT", ...numbers };
    if (SHIPPING_WORD.test(text)) return { kind: "SHIPPING", ...numbers };
    return { kind: total < 0 ? "DISCOUNT" : "OTHER", ...numbers };
  }
  return { kind: "OTHER", ...numbers };
}
