/**
 * W-1188 PR-1b guards (R13, R14): the till's void window and the day-close guard are keyed on the ENTRY instant and the
 * money dates (`createdAt` / `paidAt`), never on the sale's chosen business date. A sale dated into a closed till day is
 * accepted and that day's Z never moves; a sale entered today and dated last week can still be voided today.
 * Reading `orderDate` in either file would break both, so neither may.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("W-1188: the void window and the day close never read orderDate", () => {
  it.each([
    "orders/counter-sale/counter-sale-void.service.ts",
    "orders/counter-sale/counter-sale-void-window.ts",
    "invoices/counter-payment-guard.ts",
  ])("%s", (file) => {
    expect(code(read(file))).not.toMatch(/\borderDate\b/);
  });

  it("the void window still reads the entry instant", () => {
    expect(code(read("orders/counter-sale/counter-sale-void.service.ts"))).toMatch(/createdAt/);
  });
});
