import { formatMoney } from "./format";

/**
 * V09: a price typed on New product that is a whole number equal to the box count ("12" for a box of 12) is
 * often the quantity, not the price. The hint only asks; it never blocks. Returns null when it does not apply.
 * The only math here is the comparison; money is formatted, never computed.
 */
export function priceQtyHint(args: {
  price: string;
  unitsPerBox: string;
  /** The pack word the form already uses, lower case ("box", "case"). */
  packWord: string;
}): string | null {
  const price = args.price.trim();
  const count = args.unitsPerBox.trim();
  if (!/^\d+(\.0+)?$/.test(price) || !/^\d+$/.test(count)) return null;
  const n = Number(count);
  if (n <= 1 || Number(price) !== n) return null;
  const word = args.packWord;
  return `A ${word} holds ${n}. Is ${formatMoney(price)} the price for the whole ${word}?`;
}
