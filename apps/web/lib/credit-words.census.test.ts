/** @jest-environment node */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { COUNTER_METHOD_LABEL } from "@routeflow/pricing";
import { CREDIT_WORDS } from "@routeflow/types";

/**
 * SA-1211 A1.4 (census pin): "Credit" is the one word. The four retired names never appear in a web renderer string (a
 * string, template or JSX text; comments are excluded because the scan reads tokens). Every site still unchanged is in
 * ALLOW with its exact count. A later PR that changes a site removes its row (the count must match exactly, so a stale
 * row fails too); a new use of an old word, or a count that grew, fails here. The api has the same pin
 * (apps/api/src/common/credit-words.census.spec.ts); the phone follows one train later with its own.
 */
const OLD_WORDS = /store credit|in wallet|unallocated \(→ advance\)|advance balance/gi;

/** file (from apps/web, forward slashes) -> how many old words its renderer strings still hold */
const ALLOW: Record<string, number> = {
  "app/(dashboard)/customers/[id]/customer-statement-card.tsx": 1,
  "app/(dashboard)/customers/[id]/page.tsx": 2,
  "app/(dashboard)/finance/payments/page.tsx": 1,
  "app/(dashboard)/invoices/[id]/page.tsx": 1,
  "app/(dashboard)/orders/[id]/_components/OrderReturnsPanel.tsx": 1,
  "app/(dashboard)/orders/_components/CounterTodaysSales.tsx": 2,
  "app/(dashboard)/returns/[id]/page.tsx": 2,
  "app/(dashboard)/returns/_components/RecordInlineReturnDialog.tsx": 5,
  "app/(dashboard)/returns/_components/refund-copy.ts": 9,
  "app/buyer/portal/[seller]/finances/page.tsx": 1,
  "app/buyer/portal/[seller]/payments/page.tsx": 1,
  "lib/cancel-impact.ts": 1,
  "lib/counter-void-copy.ts": 1,
  "lib/counter-week.ts": 2,
  "lib/credit-note-error-copy.ts": 7,
  "lib/day-closed-copy.ts": 1,
  "lib/refund-slip.ts": 2,
  "lib/refund-toast.ts": 1,
};

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".jest-cache",
  "coverage",
  "e2e",
  "test-utils",
]);
const isSource = (f: string) =>
  /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && e.name !== "__tests__") {
        walk(path.join(dir, e.name), out);
      }
    } else if (isSource(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** The old words in the string-like tokens of one source file (comments never reach a token). */
function oldWordsIn(file: string): number {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      n += (node.text.match(OLD_WORDS) ?? []).length;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return n;
}

describe("the credit-word census (SA-1211 A1.4): web renderer strings", () => {
  const found: Record<string, number> = {};
  beforeAll(() => {
    for (const f of walk(ROOT)) {
      const n = oldWordsIn(f);
      if (n > 0) found[path.relative(ROOT, f).split(path.sep).join("/")] = n;
    }
  });

  it("no site outside the allow-list uses an old word, and none grew", () => {
    const grew = Object.entries(found).filter(([f, n]) => n > (ALLOW[f] ?? 0));
    expect(grew).toEqual([]);
  });

  it("the allow-list holds only sites that still use an old word, at the exact count", () => {
    const stale = Object.entries(ALLOW).filter(([f, n]) => found[f] !== n);
    expect(stale).toEqual([]);
  });

  it("the sites this cut changed are gone: the counter screen, the counter return action, the kept-credit lines", () => {
    for (const f of [
      "components/CustomerRecordPaymentModal.tsx",
      "app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
      "app/(dashboard)/orders/_components/CounterReturnAction.tsx",
    ]) {
      expect(found[f]).toBeUndefined();
    }
  });

  it("the counter method labels read the one noun (A1.4, A1.7: Advance reads Credit too)", () => {
    expect(COUNTER_METHOD_LABEL.STORE_CREDIT).toBe(CREDIT_WORDS.noun);
    expect(COUNTER_METHOD_LABEL.ADVANCE).toBe(CREDIT_WORDS.noun);
  });
});
