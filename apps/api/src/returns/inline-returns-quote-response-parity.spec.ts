/**
 * Inline returns capture web (PR 1): `packages/types/api/inline-returns.ts`'s
 * `InlineReturnQuoteChunk`/`InlineReturnQuoteBreakdown`/`InlineReturnQuoteResponse` must stay
 * exactly the shape `InlineReturnsQuoteService.quote()` actually returns — there is no
 * response DTO for the quote endpoint (design.md / SA-071b item 4), so this is the only
 * thing standing between the web client's type and a silent field rename/drop/add in the
 * pricing engine (the exact L-072 class: a hand-typed mirror drifting from its server
 * source).
 *
 * STATIC-SCAN pin, modelled on `returns-restock-parity.spec.ts`/`returns-reason-parity.
 * spec.ts` rather than `enum-parity.spec.ts`: those two exist because a runtime VALUE
 * (a literal array) can be diffed directly; a TypeScript `interface`'s field names have no
 * runtime representation at all, so — unlike `enum-parity.spec.ts`'s array diff — there is
 * nothing to `require()` and compare. A compile-time-only type-equality assertion was tried
 * first and found NOT to fail this project's `ts-jest` config on a deliberately introduced
 * extra field (verified empirically — apps/api/tsconfig.json excludes `*.spec.ts` from its
 * own `tsc -p` project, and ts-jest here does not otherwise surface a structural mismatch as
 * a suite failure), so this reads both files as TEXT and diffs their declared field names as
 * sets — the same mechanism the two restock/reason parity specs already use successfully.
 */
import * as fs from "fs";
import * as path from "path";

const PRICING_FILE = path.join(__dirname, "inline-returns-pricing.ts");
const QUOTE_SERVICE_FILE = path.join(__dirname, "inline-returns-quote.service.ts");
const SHARED_TYPES_FILE = path.join(__dirname, "../../../../packages/types/api/inline-returns.ts");

function readSource(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Extracts the top-level field NAMES of a flat `interface Name { ... }` block (no nested
 *  object-literal types — every field here is a scalar, array-of-scalar, or Record/Map
 *  alias, so a per-line match is safe and doesn't need a real parser). Strips a trailing
 *  `?` (optionality doesn't matter for a "did the field survive" check). */
function interfaceFieldNames(source: string, interfaceName: string): string[] {
  const re = new RegExp(`export interface ${interfaceName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = source.match(re);
  if (!match) return [];
  const body = match[1];
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const fieldMatch = line.match(/^\s*(?:\/\*\*.*\*\/\s*)?([A-Za-z_][A-Za-z0-9_]*)\??:\s*/);
    if (fieldMatch) fields.push(fieldMatch[1]);
  }
  return fields;
}

const pricingSource = readSource(PRICING_FILE);
const quoteServiceSource = readSource(QUOTE_SERVICE_FILE);
const sharedTypesSource = readSource(SHARED_TYPES_FILE);

describe("packages/types/api/inline-returns.ts stays pinned to the pricing engine's real shape", () => {
  it("finds every interface in source (guards against a silently-vacuous suite)", () => {
    expect(interfaceFieldNames(pricingSource, "PricedChunk").length).toBeGreaterThan(0);
    expect(interfaceFieldNames(pricingSource, "QuoteBreakdown").length).toBeGreaterThan(0);
    expect(interfaceFieldNames(sharedTypesSource, "InlineReturnQuoteChunk").length).toBeGreaterThan(
      0,
    );
    expect(
      interfaceFieldNames(sharedTypesSource, "InlineReturnQuoteBreakdown").length,
    ).toBeGreaterThan(0);
  });

  it("InlineReturnQuoteChunk names exactly PricedChunk's fields — no extra, none missing", () => {
    const server = interfaceFieldNames(pricingSource, "PricedChunk");
    const shared = interfaceFieldNames(sharedTypesSource, "InlineReturnQuoteChunk");
    expect(new Set(shared)).toEqual(new Set(server));
    expect(shared.length).toBe(server.length);
  });

  it("InlineReturnQuoteBreakdown names exactly QuoteBreakdown's fields — no extra, none missing", () => {
    const server = interfaceFieldNames(pricingSource, "QuoteBreakdown");
    const shared = interfaceFieldNames(sharedTypesSource, "InlineReturnQuoteBreakdown");
    expect(new Set(shared)).toEqual(new Set(server));
    expect(shared.length).toBe(server.length);
  });

  /** The top-level field names of the `{ ... }` object literal in quote()'s declared return type, after `QuoteBreakdown &`. */
  const engineExtraFields = (): string[] => {
    const sigMatch = quoteServiceSource.match(
      /async quote\([^)]*\):\s*Promise<\s*QuoteBreakdown\s*&\s*\{([\s\S]*?)\}\s*>/,
    );
    expect(sigMatch).not.toBeNull();
    const out: string[] = [];
    for (const line of (sigMatch as RegExpMatchArray)[1].split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*/);
      if (m) out.push(m[1]);
    }
    return out;
  };

  it("InlineReturnQuoteResponse = QuoteBreakdown + productBreakdown + InlineReturnRefundEligibility, exactly what quote()'s own return-type annotation adds", () => {
    // quote()'s declared return type: `Promise<QuoteBreakdown & { productBreakdown, canRefund, paidInFull, paidMethods,
    // customerIsWalkIn }>`: pull the intersected object literal's own field names out (not `QuoteBreakdown`'s, which the
    // previous test already pins).
    const engine = engineExtraFields();

    const responseSource = sharedTypesSource.match(
      /export interface InlineReturnQuoteResponse\s+extends InlineReturnQuoteBreakdown,\s*InlineReturnRefundEligibility\s*\{([\s\S]*?)\n\}/,
    );
    expect(responseSource).not.toBeNull();
    const own = interfaceFieldNames(
      `export interface X {${(responseSource as RegExpMatchArray)[1]}\n}`,
      "X",
    );
    expect(own).toEqual(["productBreakdown", "cashRefundable"]);

    const eligibility = interfaceFieldNames(sharedTypesSource, "InlineReturnRefundEligibility");
    expect(eligibility).toEqual([
      "canRefund",
      "paidInFull",
      "paidMethods",
      "paidWithStoreCredit",
      "customerIsWalkIn",
    ]);
    // the engine adds exactly the response's own key plus the eligibility fields: a rename, drop or add on either side fails here
    expect(new Set(engine)).toEqual(new Set([...own, ...eligibility]));
    expect(engine.length).toBe(own.length + eligibility.length);
  });

  it("the engine types the five eligibility fields as non-optional (canRefund is ALWAYS set explicitly)", () => {
    const sigMatch = quoteServiceSource.match(
      /async quote\([^)]*\):\s*Promise<\s*QuoteBreakdown\s*&\s*\{([\s\S]*?)\}\s*>/,
    );
    const body = (sigMatch as RegExpMatchArray)[1];
    expect(body).toMatch(/canRefund: boolean;/);
    expect(body).toMatch(/paidInFull: boolean;/);
    expect(body).toMatch(/paidMethods: string\[\];/);
    expect(body).toMatch(/paidWithStoreCredit: boolean;/);
    expect(body).toMatch(/customerIsWalkIn: boolean;/);
  });
});

describe("SA-727: the refund tender list the API validates equals the shared one", () => {
  it("INLINE_REFUND_TENDER_VALUES (packages/types) = REFUND_TENDERS (apps/api)", () => {
    const shared = sharedTypesSource.match(
      /INLINE_REFUND_TENDER_VALUES\s*=\s*\[([^\]]*)\]\s*as const/,
    );
    expect(shared).not.toBeNull();
    const sharedList = (shared as RegExpMatchArray)[1]
      .match(/"([A-Z_]+)"/g)
      ?.map((v) => v.slice(1, -1));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { REFUND_TENDERS } = require("./inline-return-refund");
    expect(sharedList).toEqual([...REFUND_TENDERS]);
  });
});
