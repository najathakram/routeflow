import { readFileSync } from "fs";
import { join } from "path";

/**
 * Train S2 (SA must): two paths leave a server-side invoice or sale behind, so the LOCAL draft must go before
 * anything else, or the next visit offers a restore that would create a duplicate.
 *  - row 466 kept draft: create committed and only the send failed; the page routes to that invoice.
 *  - row 485 unknown sale: the outcome is unknown (it may be committed); the locked cart keeps Try again.
 * Source pin: the page is too heavy to mount for these error paths.
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("invoices/new clears the local draft where a server copy may exist (train S2)", () => {
  it("the kept-draft path clears the draft before routing to the kept invoice", () => {
    const block = src.slice(src.indexOf("const keptId = keptDraftInvoiceId(err);"));
    const clear = block.indexOf("draft.clear();");
    const route = block.indexOf("router.push(`/invoices/${keptId}`)");
    expect(clear).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(clear);
  });

  it("an unknown sale outcome clears the draft before locking the cart", () => {
    const block = src.slice(src.indexOf("setSaleUnknown(unknown);"));
    const ifUnknown = block.indexOf("if (unknown) {");
    const clear = block.indexOf("draft.clear();");
    const ret = block.indexOf("return;");
    expect(ifUnknown).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(ifUnknown);
    expect(ret).toBeGreaterThan(clear);
  });
});
