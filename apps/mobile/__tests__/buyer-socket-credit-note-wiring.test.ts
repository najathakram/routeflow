import { readFileSync } from "fs";
import { join } from "path";

/**
 * B546 — the server emits creditNote.created AND creditNote.voided to a buyer's own room, so the
 * buyer socket must refresh the credit-note list, dashboard, statement, invoices and payments on
 * both. RN hooks aren't renderable in this jest lane (pure-logic only), so the wiring is
 * source-pinned: dropping the voided subscription would leave every other test green.
 */
describe("B546: useBuyerSocket refreshes the credit views on issue AND void", () => {
  const src = readFileSync(join(__dirname, "..", "hooks/useBuyerSocket.ts"), "utf8");

  it("subscribes to creditNote.voided as well as creditNote.created", () => {
    expect(src).toMatch(/socket\.on\("creditNote\.created"/);
    expect(src).toMatch(/socket\.on\("creditNote\.voided"/);
  });

  it("the shared refresh covers every view a credit note moves", () => {
    const at = src.indexOf("const refreshCreditViews");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('socket.on("creditNote.created"', at));
    for (const key of [
      "buyer-credit-notes",
      "buyer-dashboard",
      "buyer-statement",
      "buyer-invoices",
      "buyer-payments",
    ]) {
      expect(body).toContain(`"${key}"`);
    }
  });
});
