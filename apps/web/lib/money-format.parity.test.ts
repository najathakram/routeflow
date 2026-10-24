import { formatReceiptMoney } from "@routeflow/pricing";
import { formatMoney } from "./format";
import { fmt } from "./formatting";

/** W-882: three names, ONE formatter. Every input prints the same text through all three. */
const CASES: Array<[unknown, string]> = [
  [0, "$0.00"],
  [-0, "$0.00"],
  [-0.001, "$0.00"],
  [1234.5, "$1,234.50"],
  [12345.67, "$12,345.67"],
  [-1, "-$1.00"],
  [10.825, "$10.83"],
  [NaN, "$0.00"],
  [Infinity, "$0.00"],
  ["1234.5", "$1,234.50"],
  [null, "$0.00"],
  [undefined, "$0.00"],
];

describe("money formatter parity (W-882)", () => {
  it.each(CASES)("%p -> %s on formatMoney, fmt and formatReceiptMoney", (input, text) => {
    expect(formatReceiptMoney(input as number)).toBe(text);
    expect(formatMoney(input as number)).toBe(text);
    if (typeof input === "number") expect(fmt(input)).toBe(text);
  });
});
