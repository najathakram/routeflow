import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

/**
 * SA-1211 A1.4 (census pin): "Credit" is the one word. The four retired names never appear in an api renderer string (a
 * string, template or JSX text in the receipt model, an email, a PDF; comments are excluded because the scan reads
 * tokens). Every site still unchanged is in ALLOW with its exact count. A later PR that changes a site removes its row (the
 * count must match exactly, so a stale row fails too); a new use of an old word, or a count that grew, fails here. The web
 * has the same pin (apps/web/lib/credit-words.census.test.ts); the phone follows one train later with its own.
 */
const OLD_WORDS = /store credit|in wallet|unallocated \(→ advance\)|advance balance/gi;

/** file (from apps/api/src, forward slashes) -> how many old words its renderer strings still hold */
const ALLOW: Record<string, number> = {
  "buyer/statement-pdf-template.tsx": 1,
  "credit-notes/line-credit-headroom.ts": 1,
  "credit-notes/walk-in-credit-guard.ts": 1,
  "customers/customers.service.ts": 1,
  "orders/counter-sale/counter-sale-void-errors.ts": 1,
  "returns/cash-refund-cap.ts": 1,
  "returns/inline-return-refund.ts": 4,
  "returns/inline-returns.service.ts": 2,
  "returns/returns.service.ts": 4,
  "returns/standard-refund-claim.ts": 1,
};

const ROOT = join(__dirname, "..");
const isSource = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.(spec|test)\.(ts|tsx)$/.test(f);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else if (isSource(e.name)) out.push(join(dir, e.name));
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

describe("the credit-word census (SA-1211 A1.4): api renderer strings", () => {
  const found: Record<string, number> = {};
  beforeAll(() => {
    for (const f of walk(ROOT)) {
      const n = oldWordsIn(f);
      if (n > 0) found[relative(ROOT, f).split(sep).join("/")] = n;
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

  it("the sites this cut changed are gone: the receipt model", () => {
    expect(found["documents/receipt-model.ts"]).toBeUndefined();
  });
});
