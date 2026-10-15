/**
 * #2717 M3 (SA-579 Q4): the bwip-js `bcid` for a stored unit barcode. UPC-A, EAN-13 and EAN-8 print
 * natively only when the code is all digits of the matching length AND its GS1 check digit
 * validates; every other case (GTIN-14, CODE128, no symbology, a bad check digit) is `code128`,
 * which encodes any text and so can never make the renderer throw.
 */
export type BwipBcid = "upca" | "ean13" | "ean8" | "code128";

const LENGTH: Record<string, number> = { UPC_A: 12, EAN_13: 13, EAN_8: 8 };
const BCID: Record<string, BwipBcid> = { UPC_A: "upca", EAN_13: "ean13", EAN_8: "ean8" };

/** GS1 mod-10: the last digit is the check digit; weights 3,1,3,1... from the digit before it. */
export function hasValidGs1CheckDigit(code: string): boolean {
  if (!/^\d+$/.test(code) || code.length < 2) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

export function bcidFor(symbology: string | null | undefined, code: string): BwipBcid {
  const trimmed = (code ?? "").trim();
  const bcid = symbology ? BCID[symbology] : undefined;
  if (!bcid || trimmed.length !== LENGTH[symbology as string]) return "code128";
  return hasValidGs1CheckDigit(trimmed) ? bcid : "code128";
}
