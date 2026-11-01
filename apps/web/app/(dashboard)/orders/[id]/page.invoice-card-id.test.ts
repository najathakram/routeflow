import * as fs from "fs";
import * as path from "path";
import { INVOICE_CARD_ID } from "./_components/PosOrderActions";

/**
 * SA-1066 F01 (review): the Invoice step scrolls to `INVOICE_CARD_ID` when no Generate Invoice button is drawn. Rendering the
 * order page is heavy, so this reads its source: the Invoice Card must carry that very constant as its id (and import it from
 * the module PosProgress scrolls with), so renaming or dropping either side goes red.
 */
const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("the order page's Invoice card is where the Invoice step scrolls", () => {
  it("the shared id is the one the step and the page agree on", () => {
    expect(INVOICE_CARD_ID).toBe("invoice-card");
  });

  it("the Invoice <Card> takes id={INVOICE_CARD_ID}", () => {
    expect(source).toMatch(/<Card\s[^>]*id=\{INVOICE_CARD_ID\}[^>]*title=\{`Invoice/);
  });

  it("page.tsx imports INVOICE_CARD_ID from PosOrderActions, the module PosProgress lives in", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bINVOICE_CARD_ID\b[^}]*\}\s*from\s*"\.\/_components\/PosOrderActions"/,
    );
  });
});
