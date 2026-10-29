import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * SA-1053 (I-192) class pin: every reader of an order's or an invoice's credited amount counts the order's refund notes that were
 * minted before the order was invoiced, through ONE helper. `loadUnlinkedRefundReturns` is called in exactly three places: the
 * single-invoice reader (`loadLineCredits`), the order pool (`loadOrderPool`) and the credit-note door's order-wide bound
 * (`validateAndBuildCnItems`). A fourth credit reader must either call it (and move this count on purpose) or be named in the
 * PR that adds it. The predicate for "no invoice" is written once, in the helper.
 */
const SRC = join(__dirname, "..");
const HEADROOM = join(__dirname, "line-credit-headroom.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : sourceFiles(p);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [p] : [];
  });
}

describe("SA-1053: one helper counts the refunds minted before the order was invoiced", () => {
  it("loadUnlinkedRefundReturns( is called exactly 3 times outside specs (the definition does not count)", () => {
    const calls = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(
          (l) =>
            l.includes("loadUnlinkedRefundReturns(") &&
            !/function\s+loadUnlinkedRefundReturns/.test(l),
        )
        .map((l) => `${file.slice(SRC.length + 1).replace(/\\/g, "/")}: ${l.trim()}`),
    );
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("credit-notes/line-credit-headroom.ts"))).toHaveLength(
      2,
    );
    expect(calls.filter((c) => c.startsWith("credit-notes/credit-notes.service.ts"))).toHaveLength(
      1,
    );
  });

  it("A-1: loadLineCredits counts the order's creditable invoices ONCE, and that one count gates both order-scoped terms", () => {
    const text = readFileSync(HEADROOM, "utf8");
    const start = text.indexOf("export async function loadLineCredits");
    const end = text.indexOf("\nexport ", start + 1);
    const body = text.slice(start, end);
    expect(body.match(/countCreditableInvoices\(/g)).toHaveLength(1);
    // both the unlinked-refund replay and the SA-727 external-refund replay sit behind the same helper
    expect(body.match(/await isSoleInvoice\(\)/g)).toHaveLength(2);
  });

  it("the no-invoice predicate is written once in line-credit-headroom.ts, in the helper", () => {
    const text = readFileSync(HEADROOM, "utf8");
    const at = text.indexOf("invoiceId: null");
    expect(at).toBeGreaterThan(-1);
    expect(text.indexOf("invoiceId: null", at + 1)).toBe(-1);
    const helperStart = text.indexOf("export async function loadUnlinkedRefundReturns");
    const helperEnd = text.indexOf("\nexport ", helperStart + 1);
    expect(at).toBeGreaterThan(helperStart);
    expect(at).toBeLessThan(helperEnd);
  });
});
