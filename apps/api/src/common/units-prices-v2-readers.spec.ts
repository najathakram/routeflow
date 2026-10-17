import * as fs from "fs";
import * as path from "path";

/**
 * Units S19 / S19a (T26 inventory): every API reader that turns a customer into a tier goes through
 * `customerPricing` (orders/units-prices-v2.ts), which is master's `cp.pricingTier ?? customer.pricingTier ?? 1` with
 * the flag off and `customerTierFor` plus the customer layer (typed prices) with `flag.units_prices_v2` on. A new inline
 * chain (`x.pricingTier ?? y`, `y ?? x.pricingTier`) or per-product tier map entry (`[r.productId, r.pricingTier]`) is red
 * here: wire it through `customerPricing`, or list it below with its reason.
 *
 * Comments are ignored. `units-prices-v2.ts` (the resolver) is exempt.
 */
const SRC = path.resolve(__dirname, "..");
const CHAIN =
  /pricingTier\s*\?\?|\?\?\s*[\w.?]*pricingTier\b|\[\s*[\w.]+\.productId\s*,\s*[\w.]+\.pricingTier(?:\s+as\s+number)?\s*\]|\.set\(\s*[\w.]+\s*,\s*[\w.?]+\.pricingTier\s*\)|Number\(\s*[\w.?]*\.pricingTier\s*\)/g;
const RESOLVER = "orders/units-prices-v2.ts";

/** Files that must call the one resolver (the wired readers). */
const WIRED = [
  "orders/orders.service.ts",
  "orders/unit-line-edit.ts",
  "invoices/invoice-line-override.ts",
  "order-templates/order-templates.service.ts",
  "estimates/estimates.service.ts",
  "buyer/buyer-catalog.service.ts",
  "returns/inline-returns-quote.service.ts",
  "buyer/buyer-dashboard.service.ts",
  "customers/customer-price-history.service.ts",
  "orders/counter-sale/counter-sale-tier-price.ts",
  "invoices/manual-invoice-context.ts",
];

/**
 * Inline chains that remain, with the count and why each stays: none of them prices a line the customer is shown or charged
 * (a write of the tier field, the old-client Piece echo comparison, a replay compare, the flag-off tier map); the price itself
 * comes from `customerPricing` (proofs named per entry).
 */
const REMAINING: Record<string, { count: number; why: string }> = {
  "customers/customers.service.ts": {
    count: 1,
    why: "a write of the customer's own tier field, not a price read",
  },
  "invoices/invoices.service.ts": {
    count: 1,
    why: "derivedBaseCustomer.tier: the default tier that describes an old-client Piece echo; the CHARGED pack price is the layer's (manual-invoice-context.units-prices-v2.spec A-7)",
  },
  "invoices/manual-invoice-context.ts": {
    count: 1,
    why: "the tier map that describes an old-client Piece echo; the CHARGED pack price is the layer's (manual-invoice-context.units-prices-v2.spec A-7)",
  },
  "orders/replay-cart-normalize.ts": {
    count: 2,
    why: "replay cart compare only (never prices a line); the charged line is the layer's (orders.units-prices-v2.spec A-7)",
  },
  "orders/unit-line-edit.ts": {
    count: 2,
    why: "normalizeDerivedBaseItems tier for an old-client Piece echo; the charged line is the layer's (orders.update-units-prices-v2.spec A-7)",
  },
  "returns/inline-returns-quote.service.ts": {
    count: 2,
    why: "the flag-off tier map; flag on the unreferenced price comes from customerPricing",
  },
};

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) out.push(p);
  }
}

describe("S19a: one tier resolver for the customer-to-tier readers", () => {
  const files: string[] = [];
  walk(SRC, files);
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const hits = new Map<string, number>();
  for (const f of files) {
    const r = rel(f);
    if (r === RESOLVER) continue;
    const n = (strip(fs.readFileSync(f, "utf8")).match(CHAIN) ?? []).length;
    if (n > 0) hits.set(r, n);
  }

  it("no new inline tier chain or tier map outside the resolver and the listed remainder", () => {
    const unexpected = [...hits].filter(([f, n]) => REMAINING[f]?.count !== n);
    expect(unexpected).toEqual([]);
  });

  it("the listed remainder holds no stale entry", () => {
    expect(Object.keys(REMAINING).filter((f) => !hits.has(f))).toEqual([]);
  });

  it.each(WIRED)("%s calls customerPricing", (f) => {
    expect(strip(fs.readFileSync(path.join(SRC, f), "utf8"))).toMatch(/\bcustomerPricing\(/);
  });

  it("the pin is live: the patterns catch the shapes the review named", () => {
    const hit = (s: string) => (s.match(CHAIN) ?? []).length;
    expect(hit("const t = cp?.pricingTier ?? customer.pricingTier ?? 1;")).toBeGreaterThan(0);
    expect(hit("const t = tierOf.get(id) ?? customer.pricingTier;")).toBeGreaterThan(0);
    expect(hit("new Map(rows.map((cp) => [cp.productId, cp.pricingTier]))")).toBeGreaterThan(0);
    expect(hit("tierOf.set(r.productId, r.pricingTier);")).toBeGreaterThan(0);
    expect(hit("const t = Number(cp.pricingTier);")).toBeGreaterThan(0);
    expect(hit("customerPricing(svc, id, ids, customer, rows)")).toBe(0);
  });
});
