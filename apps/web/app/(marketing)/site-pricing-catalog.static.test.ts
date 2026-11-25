/**
 * @jest-environment node
 */
// Pricing v14 Phase 1 (2026-11-24): the public prices are pinned to the plan catalog ON SALE today, never to a
// catalog that is decided but not published. The owner's correction of 2026-11-24: pin the page to the version on sale
// (v13 today: Starter $99, Growth $249, Scale $499), and move ON_SALE_VERSION only in the PR that puts the next
// catalog on sale. The planned one-line pricing page passes unchanged as long as its numbers stay data-bound spans.
//
// Three layers, each read from source, never re-typed here:
//   1. the catalog: apps/api/prisma/plan-catalog-v11..v13 definitions, read with the TypeScript parser (L-377),
//      with the v12 and v13 carry-forward checked structurally so a v13 edit cannot slip past;
//   2. apps/web/public/site/js/prices.js, the ONE price object site.js writes into every data-bound span;
//   3. every [data-plan][data-field] and [data-addon][data-field] span in the site pages (the no-JS text), plus
//      every hand-typed "$N" and "Up to N" on the pricing and landing pages.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as ts from "typescript";

/** The catalog version on sale today. Change it only in the PR that publishes the next catalog and its page. */
const ON_SALE_VERSION = 13;

const ROOT = path.resolve(__dirname, "../../../..");
const PRISMA = path.join(ROOT, "apps/api/prisma");
const SITE = path.resolve(__dirname, "../../public/site");

type Lit = string | number | boolean | null;
type Obj = Record<string, Lit>;

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function initializer(sf: ts.SourceFile, name: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${path.basename(sf.fileName)}: no initializer for ${name}`);
  return found;
}

function literal(e: ts.Expression): Lit | undefined {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

/** The literal-valued properties of each object literal in an array literal. */
function objects(e: ts.Expression): Obj[] {
  if (!ts.isArrayLiteralExpression(e)) throw new Error("expected an array literal");
  return e.elements.map((el) => {
    if (!ts.isObjectLiteralExpression(el)) throw new Error("expected an object literal");
    const o: Obj = {};
    for (const p of el.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        const v = literal(p.initializer);
        if (v !== undefined) o[p.name.text] = v;
      }
    }
    return o;
  });
}

/**
 * The v13 catalog's plans and add-ons. v13 = v12 with LITE's flags changed; v12 = LITE + v11's plans with only
 * featureFlags and sortOrder overridden; both reuse v11's add-on seeds. Each step is asserted, so a later edit that
 * changes a price inside v12 or v13 breaks this reader loudly instead of being read past.
 */
function catalogOnSale() {
  if (ON_SALE_VERSION !== 13) {
    throw new Error(
      `teach catalogOnSale() the v${ON_SALE_VERSION} definitions before moving ON_SALE_VERSION`,
    );
  }
  const v13 = source(path.join(PRISMA, "plan-catalog-v13.definitions.ts"));
  const v12 = source(path.join(PRISMA, "plan-catalog-v12.definitions.ts"));
  const v11 = source(path.join(PRISMA, "plan-catalog-v11.definitions.ts"));

  const v13Defs = initializer(v13, "V13_DEFINITIONS").getText();
  if (!v13Defs.startsWith("V12_DEFINITIONS.map(") || !/d\.planKey === "LITE"/.test(v13Defs)) {
    throw new Error("V13_DEFINITIONS is no longer v12 with LITE alone changed");
  }
  if (initializer(v13, "V13_ADDON_SEEDS").getText() !== "V12_ADDON_SEEDS") {
    throw new Error("V13_ADDON_SEEDS is no longer V12_ADDON_SEEDS");
  }
  if (initializer(v12, "V12_ADDON_SEEDS").getText() !== "V11_ADDON_SEEDS") {
    throw new Error("V12_ADDON_SEEDS is no longer V11_ADDON_SEEDS");
  }
  const v12Defs = initializer(v12, "V12_DEFINITIONS");
  if (!ts.isArrayLiteralExpression(v12Defs)) throw new Error("V12_DEFINITIONS is not an array");
  const spread = v12Defs.elements.find(ts.isSpreadElement);
  if (!spread || !spread.getText().startsWith("...V11_DEFINITIONS.map(")) {
    throw new Error("V12_DEFINITIONS no longer spreads V11_DEFINITIONS");
  }
  const overridden = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) overridden.add(p.name.text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(spread);
  if ([...overridden].sort().join(",") !== "featureFlags,sortOrder") {
    throw new Error(`V12_DEFINITIONS overrides ${[...overridden].join(",")} of v11's plans`);
  }

  const plans = objects(initializer(v11, "V11_DEFINITIONS"));
  const addons = objects(initializer(v11, "V11_ADDON_SEEDS"));
  const constants = source(path.join(ROOT, "apps/api/src/billing/plan-catalog.constants.ts"));
  const trialDays = literal(initializer(constants, "TRIAL_LENGTH_DAYS"));
  return { plans, addons, trialDays };
}

type SitePrices = {
  catalogVersion: number;
  yearlyMonthsBilled: number;
  trialDays: number;
  plans: Record<string, { name: string; monthly: number; customers: number; yearly: number }>;
  enterprise: { custom: boolean };
  addons: Record<
    string,
    { name: string; monthly: number; customers?: number; stackable?: boolean }
  >;
};

function sitePrices(): SitePrices {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(SITE, "js/prices.js"), "utf8"), sandbox, {
    filename: "prices.js",
  });
  const p = sandbox.window.RF_PRICES as SitePrices | undefined;
  if (!p) throw new Error("prices.js did not set window.RF_PRICES");
  return p;
}

/** The site's add-on keys and the catalog SKU each one sells. */
const SITE_ADDON_SKU: Record<string, string> = {
  REGULATED: "REGULATED_ITEMS",
  CUSTOMER_PACK: "CUSTOMER_PACK_100",
};

const pages = () => fs.readdirSync(SITE).filter((f) => f.endsWith(".html"));
const html = (f: string) => fs.readFileSync(path.join(SITE, f), "utf8");
const num = (s: string) => Number(s.replace(/,/g, ""));

describe(`the public prices match the plan catalog on sale (v${ON_SALE_VERSION})`, () => {
  const catalog = catalogOnSale();
  const site = sitePrices();
  const plan = (key: string) => catalog.plans.find((p) => p.planKey === key);
  const sku = (key: string) => catalog.addons.find((a) => a.sku === key);

  it("reads the catalog: four plans, the add-on seeds and the trial length", () => {
    expect(catalog.plans.map((p) => p.planKey)).toEqual([
      "STARTER",
      "GROWTH",
      "SCALE",
      "ENTERPRISE",
    ]);
    expect(catalog.addons.length).toBeGreaterThanOrEqual(2);
    expect(typeof catalog.trialDays).toBe("number");
  });

  it("prices.js says which catalog it shows, and it is the one on sale", () => {
    expect(site.catalogVersion).toBe(ON_SALE_VERSION);
    expect(fs.existsSync(path.join(PRISMA, `publish-plan-catalog-v${ON_SALE_VERSION}.ts`))).toBe(
      true,
    );
  });

  it("every plan on the site has the catalog's name, monthly price and customers", () => {
    const shown = Object.keys(site.plans);
    expect(shown.length).toBeGreaterThan(0);
    for (const key of shown) {
      const c = plan(key);
      expect(`${key}: ${c ? "in the catalog" : "missing"}`).toBe(`${key}: in the catalog`);
      const s = site.plans[key];
      expect({ key, name: s.name, monthly: s.monthly, customers: s.customers }).toEqual({
        key,
        name: c?.name,
        monthly: c?.monthlyPrice,
        customers: c?.customersIncluded,
      });
    }
    // every priced plan the catalog sells is on the site; the custom one shows as "Enterprise, custom"
    const priced = catalog.plans.filter((p) => !p.isCustom).map((p) => String(p.planKey));
    expect([...shown].sort()).toEqual(priced.sort());
    expect(site.enterprise.custom).toBe(plan("ENTERPRISE")?.isCustom);
  });

  it("a year is ten months' price (billing-math annualPrice; annual-price-derivation.pin.spec.ts)", () => {
    // The ten is pinned once, on the site's own constant. Each plan's yearly figure is then checked
    // against that constant. The derivation pin allows a hand-written "monthly times ten" only in
    // plan-price.ts.
    const months = site.yearlyMonthsBilled;
    expect(months).toBe(10);
    for (const [key, p] of Object.entries(site.plans)) {
      expect(`${key} ${p.yearly}`).toBe(`${key} ${months * p.monthly}`);
    }
  });

  it("the trial length is the catalog's", () => {
    expect(site.trialDays).toBe(catalog.trialDays);
  });

  it("every add-on on the site is the catalog SKU it names, at the catalog price", () => {
    expect(Object.keys(site.addons).sort()).toEqual(Object.keys(SITE_ADDON_SKU).sort());
    for (const [key, a] of Object.entries(site.addons)) {
      const c = sku(SITE_ADDON_SKU[key]);
      expect({ key, monthly: a.monthly }).toEqual({ key, monthly: c?.monthlyPrice });
      if (a.customers !== undefined) {
        expect({ key, customers: a.customers }).toEqual({ key, customers: c?.capacityPerUnit });
      }
      if (a.stackable !== undefined) {
        expect({ key, stackable: a.stackable }).toEqual({ key, stackable: c?.stackable });
      }
    }
  });

  it("the regulated-items fee line follows the catalog's included-at plan", () => {
    expect(sku("REGULATED_ITEMS")?.includedAtPlan).toBe("SCALE");
    expect(html("pricing.html")).toMatch(/No fee on Scale and Enterprise\./);
  });

  it("every data-bound price span holds the value prices.js gives it", () => {
    const bad: string[] = [];
    let seen = 0;
    const re = /data-(plan|addon)="([A-Z_]+)" data-field="([a-z]+)">([^<]*)</g;
    for (const f of pages()) {
      for (const m of html(f).matchAll(re)) {
        seen += 1;
        const [, kind, key, field, text] = m;
        const src = kind === "plan" ? site.plans[key] : site.addons[key];
        const want = src ? (src as Record<string, unknown>)[field] : undefined;
        if (typeof want !== "number" || num(text) !== want) {
          bad.push(`${f}: data-${kind}="${key}" ${field} shows "${text}", wants ${want}`);
        }
      }
    }
    expect(seen).toBe(42); // exact: 51 on master, minus the nine yearly spans (SA-1282 item 3)
    expect(bad).toEqual([]);
  });

  it("every hand-typed price and customer count on the pricing and landing pages is a catalog value", () => {
    const prices = new Set<number>();
    for (const p of Object.values(site.plans)) prices.add(p.monthly).add(p.yearly);
    for (const a of Object.values(site.addons)) prices.add(a.monthly);
    const counts = new Set<number>(Object.values(site.plans).map((p) => p.customers));
    const bad: string[] = [];
    let seen = 0;
    for (const f of ["pricing.html", "landing.html"]) {
      const text = html(f);
      for (const m of text.matchAll(/\$\s?(\d[\d,]*)/g)) {
        seen += 1;
        if (!prices.has(num(m[1]))) bad.push(`${f}: $${m[1]}`);
      }
      for (const m of text.matchAll(/Up to (\d[\d,]*)/g)) {
        seen += 1;
        if (!counts.has(num(m[1]))) bad.push(`${f}: Up to ${m[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(3);
    expect(bad).toEqual([]);
  });

  it("no page shows a yearly price or a pay-yearly offer while checkout refuses a year", () => {
    // SA-1282 item 3. Tied to the code fact: billing.service.ts throws CHECKOUT_ANNUAL_NOT_SUPPORTED for
    // interval "year". While that refusal is there, a visible yearly figure or pay-yearly sentence is a claim the
    // code does not prove. The yearly number stays in prices.js as data. When yearly checkout ships the refusal
    // goes, and this case has nothing left to guard.
    const billing = fs.readFileSync(
      path.join(ROOT, "apps/api/src/billing/billing.service.ts"),
      "utf8",
    );
    if (!/CHECKOUT_ANNUAL_NOT_SUPPORTED/.test(billing)) return;
    const offer = /a year|each year|per year|yearly|annual|months free/gi;
    const bad: string[] = [];
    for (const f of pages()) {
      const text = html(f);
      if (/data-field="yearly"/.test(text)) bad.push(`${f}: data-field="yearly" span`);
      for (const m of text.matchAll(offer)) {
        const at = m.index ?? 0;
        bad.push(`${f}: ...${text.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, " ")}...`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no page promises 'no customer limit' while the priced plans on sale carry one", () => {
    const capped = catalog.plans
      .filter((p) => !p.isCustom)
      .every((p) => typeof p.customersIncluded === "number");
    expect(capped).toBe(true);
    const hits = pages().filter((f) => /no customer limit|no limit on customers/i.test(html(f)));
    expect(hits).toEqual([]);
  });
});
