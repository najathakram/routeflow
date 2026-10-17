import * as fs from "fs";
import * as path from "path";

/**
 * S19b A-pin (SA-811 section 3, SA-813): no reader prices a customer from the raw tier columns outside the one resolver.
 *
 * With `flag.units_prices_v2` on, everything that SHOWS or CHARGES a customer price takes it from `customerPricing().layer`
 * (api) or `customerLinePrice` (web, mobile), which fall back to master's tier price themselves. So a direct `getTierPrice(` call, an
 * inline `pricingTier ??` chain, or a hand-built per-product tier map is a place a tile can disagree with the cart. This spec
 * counts those shapes in every non-test source of the three apps and compares each file with the allow-list below:
 *
 *   - a new file with a match is not in the allow-list: RED;
 *   - an extra call in a listed file is a count mismatch: RED;
 *   - a listed CHARGES / SHOWS-CUSTOMER file must also be wired (it names the resolver): RED if it loses that;
 *   - a listed file that no longer matches is stale: RED.
 *
 * \`packages/**\` holds the helpers and is out of scope. Comments are ignored. A grant of flag.units_prices_v2 waits for this to
 * be green (SA-811).
 */
const ROOT = path.resolve(__dirname, "../../../..");
const SCOPE = [
  "apps/api/src",
  "apps/web/app",
  "apps/web/lib",
  "apps/web/components",
  "apps/web/hooks",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
  "apps/mobile/hooks",
];

const PATTERNS: Record<string, RegExp> = {
  getTierPrice: /\bgetTierPrice\(/g,
  chain: /pricingTier\s*\?\?|\?\?\s*[\w.?]*pricingTier\b/g,
  mapEntry: /\[\s*[\w.]+\.productId\s*,\s*[\w.]+\.pricingTier(?:\s+as\s+number)?\s*\]/g,
  mapSet: /\.set\(\s*[\w.]+\s*,\s*[\w.?]+\.pricingTier\s*\)/g,
  numberOf: /Number\(\s*[\w.?]*\.pricingTier\s*\)/g,
};
type Counts = Partial<Record<keyof typeof PATTERNS, number>>;

/** A file wired to the resolver names one of these. */
const WIRED =
  /\bcustomerPricing\(|\.layer\(|layerOf|customerLinePrice\(|useCustomerPriceLayer|layer\??\.(?:price|listPrice)/;

/** The resolver itself: the one place a raw tier is validated (exempt, like packages/**). */
const EXEMPT = new Set(["apps/api/src/orders/units-prices-v2.ts"]);

interface Entry {
  counts: Counts;
  why: string;
  /** SHOWS-LIST: shows the LIST price on purpose (a catalog price list), so it need not name the resolver. */
  showsList?: true;
}
const FALLBACK = "flag-off fallback after the layer (layer?.price ?? getTierPrice(...))";
const TIER =
  "tier carrier: the tier handed to customerLinePrice (flag-off: master's chain); the price itself is the resolver's";
const ALLOW: Record<string, Entry> = {
  // ── api: S19 / S19b wired fallbacks (each also matches WIRED)
  "apps/api/src/buyer/buyer-catalog.service.ts": { counts: { getTierPrice: 4 }, why: FALLBACK },
  "apps/api/src/buyer/buyer-dashboard.service.ts": { counts: { getTierPrice: 4 }, why: FALLBACK },
  "apps/api/src/customers/customer-price-history.service.ts": {
    counts: { getTierPrice: 1 },
    why: FALLBACK,
  },
  "apps/api/src/estimates/estimates.service.ts": { counts: { getTierPrice: 1 }, why: FALLBACK },
  "apps/api/src/orders/buyer-cart-price-check.ts": { counts: { getTierPrice: 1 }, why: FALLBACK },
  "apps/api/src/orders/buyer-merge-pricing.ts": {
    counts: { getTierPrice: 1 },
    why: "flag-off tier base after the layer",
  },
  "apps/api/src/orders/counter-sale/counter-sale-tier-price.ts": {
    counts: { getTierPrice: 1 },
    why: FALLBACK,
  },
  "apps/api/src/orders/orders.service.ts": { counts: { getTierPrice: 3 }, why: FALLBACK },
  "apps/api/src/orders/replace-all-line-build.ts": { counts: { getTierPrice: 1 }, why: FALLBACK },
  "apps/api/src/orders/staff-override.ts": { counts: { getTierPrice: 1 }, why: FALLBACK },
  "apps/api/src/returns/inline-returns-quote.service.ts": {
    counts: { getTierPrice: 1, chain: 1, mapEntry: 1 },
    why: FALLBACK,
  },
  // ── api: SHOWS-LIST
  "apps/api/src/products/family-price.ts": {
    counts: { getTierPrice: 1 },
    why: "a variant family's five tier list prices",
    showsList: true,
  },
  // ── api: chains and maps that remain (none prices a customer line; proofs named in units-prices-v2-readers.spec)
  "apps/api/src/customers/customers.service.ts": {
    counts: { chain: 1 },
    why: "a write of the customer's own tier field",
    showsList: true,
  },
  "apps/api/src/invoices/invoices.service.ts": {
    counts: { chain: 1 },
    why: "derivedBaseCustomer.tier, the old-client Piece echo default; the charged price is the layer's (A-7)",
    showsList: true,
  },
  "apps/api/src/invoices/manual-invoice-context.ts": {
    counts: { mapEntry: 1 },
    why: "the old-client Piece echo tier map; the charged pack price is the layer's (A-7)",
  },
  "apps/api/src/orders/replay-cart-normalize.ts": {
    counts: { chain: 1, mapEntry: 1 },
    why: "replay cart compare only; never prices a line",
    showsList: true,
  },
  "apps/api/src/orders/unit-line-edit.ts": {
    counts: { chain: 1, mapSet: 1 },
    why: "old-client Piece echo tier; the charged line is the layer's (A-7)",
  },
  // ── web: tier carriers (each also matches WIRED: it prices through customerLinePrice)
  "apps/web/app/(dashboard)/estimates/page.tsx": { counts: { chain: 3, mapSet: 1 }, why: TIER },
  "apps/web/app/(dashboard)/invoices/new/invoice-draft-restore.ts": {
    counts: { chain: 1 },
    why: TIER,
  },
  "apps/web/app/(dashboard)/invoices/new/page.tsx": { counts: { chain: 5 }, why: TIER },
  "apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx": { counts: { chain: 4 }, why: TIER },
  "apps/web/app/(dashboard)/orders/[id]/page.tsx": { counts: { chain: 1, mapSet: 1 }, why: TIER },
  "apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx": {
    counts: { chain: 4 },
    why: TIER,
  },
  "apps/web/app/(dashboard)/orders/_components/useCounterReprice.ts": {
    counts: { chain: 4 },
    why: TIER,
  },
  // ── web: SHOWS-LIST (the product page's own list prices; the customer page's price list)
  "apps/web/app/(dashboard)/products/[id]/page.tsx": {
    counts: { getTierPrice: 2 },
    why: "the product's own tier list prices",
    showsList: true,
  },
  "apps/web/app/(dashboard)/customers/[id]/page.tsx": {
    counts: { getTierPrice: 2, chain: 8 },
    why: "SHOWS-LIST rows (the pack row reads the layer, slice C)",
    showsList: true,
  },
  // ── mobile
  "apps/mobile/app/(operator)/(tabs)/invoices/new.tsx": {
    counts: { chain: 1, mapSet: 1 },
    why: TIER,
  },
  "apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx": {
    counts: { chain: 1, mapSet: 1 },
    why: TIER,
  },
  "apps/mobile/components/NewOrderScreen.tsx": { counts: { chain: 1, mapSet: 1 }, why: TIER },
  "apps/mobile/app/(operator)/customers/[id]/catalog.tsx": {
    counts: { getTierPrice: 2, chain: 3 },
    why: "SHOWS-LIST rows (the tier list); the priced row reads the layer (slice D)",
    showsList: true,
  },
  "apps/mobile/app/(operator)/customers/[id].tsx": {
    counts: { chain: 1 },
    why: "the customer's tier label on the detail screen (not a price)",
    showsList: true,
  },
  "apps/mobile/components/CustomerForm.tsx": {
    counts: { chain: 1 },
    why: "the customer form's own tier field (a write of the customer's tier, not a price read)",
    showsList: true,
  },
};

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SKIP_DIR = new Set(["node_modules", "dist", ".next", "__tests__", "__mocks__", "e2e"]);
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\.|\.d\.ts$/.test(e.name)) out.push(p);
  }
}

export function countShapes(source: string): Counts {
  const text = strip(source);
  const out: Counts = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    const n = (text.match(new RegExp(re.source, "g")) ?? []).length;
    if (n > 0) out[name as keyof typeof PATTERNS] = n;
  }
  return out;
}

describe("S19b A-pin: no direct customer tier price outside the one resolver", () => {
  const files: string[] = [];
  for (const d of SCOPE) walk(path.join(ROOT, d), files);
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
  const found = new Map<string, { counts: Counts; text: string }>();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const counts = countShapes(src);
    if (!EXEMPT.has(rel(f)) && Object.keys(counts).length > 0)
      found.set(rel(f), { counts, text: strip(src) });
  }
  const show = (c: Counts) => JSON.stringify(c);

  it("scans all three apps (a path typo cannot turn the pin vacuous)", () => {
    expect(files.some((f) => rel(f).startsWith("apps/api/src/orders/"))).toBe(true);
    expect(files.some((f) => rel(f).startsWith("apps/web/app/"))).toBe(true);
    expect(files.some((f) => rel(f).startsWith("apps/mobile/"))).toBe(true);
  });

  it("every file with a direct shape is allow-listed with exactly that count", () => {
    const bad = [...found]
      .filter(([f, v]) => show(ALLOW[f]?.counts ?? {}) !== show(v.counts))
      .map(([f, v]) => `${f}: found ${show(v.counts)}, allowed ${show(ALLOW[f]?.counts ?? {})}`);
    expect(bad).toEqual([]);
  });

  it("the allow-list holds no stale entry (every listed file still matches)", () => {
    expect(Object.keys(ALLOW).filter((f) => !found.has(f))).toEqual([]);
  });

  it("every allow-listed CHARGES or SHOWS-CUSTOMER file is wired to the resolver, not just counted", () => {
    const unwired = Object.entries(ALLOW)
      .filter(([, e]) => !e.showsList)
      .map(([f]) => f)
      .filter((f) => !found.get(f) || !WIRED.test(found.get(f)!.text));
    expect(unwired).toEqual([]);
  });

  it("web and mobile: zero getTierPrice outside the SHOWS-LIST files (every other site prices through customerLinePrice)", () => {
    const outside = [...found]
      .filter(
        ([f, v]) =>
          (f.startsWith("apps/web/") || f.startsWith("apps/mobile/")) && v.counts.getTierPrice,
      )
      .map(([f]) => f)
      .filter((f) => !ALLOW[f]?.showsList);
    expect(outside).toEqual([]);
  });

  it("the pin is live: each shape hits, the resolver call does not", () => {
    expect(countShapes("const p = getTierPrice(product, tier);").getTierPrice).toBe(1);
    expect(countShapes("const t = cpMap.get(id) ?? customer.pricingTier;").chain).toBeGreaterThan(
      0,
    );
    expect(countShapes("const t = cp?.pricingTier ?? 1;").chain).toBeGreaterThan(0);
    expect(countShapes("new Map(rows.map((r) => [r.productId, r.pricingTier]))").mapEntry).toBe(1);
    expect(countShapes("tierOf.set(r.productId, r.pricingTier);").mapSet).toBe(1);
    expect(countShapes("const t = Number(cp.pricingTier);").numberOf).toBe(1);
    expect(countShapes("// getTierPrice(p, t)\n/* cp.pricingTier ?? 1 */")).toEqual({});
    expect(
      countShapes("const l = customerLinePrice({ product, tier, layer, unitLabel });"),
    ).toEqual({});
  });
});
