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

/**
 * SA-1287 A1: the regulated-items fee claim is a contract, not a free sentence.
 *  - Every element that states the fee carries data-claim="regulated-fee", and its text must EQUAL one of the texts
 *    allowedFeeTexts() derives from the catalog (plan order, included-at plan, add-on price).
 *  - A sweep over every site page fails any fee sentence outside a carrier.
 *  - At least one carrier must exist on the site.
 */
const FEE_MARK = 'data-claim="regulated-fee"';
type FeePlan = { planKey: string; name: string };

const listNames = (n: string[]) =>
  n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;

function allowedFeeTexts(
  plans: ReadonlyArray<FeePlan>,
  includedAt: string | null | undefined,
  monthly: unknown,
) {
  const i = plans.findIndex((p) => p.planKey === includedAt);
  if (i < 0) throw new Error(`includedAtPlan ${String(includedAt)} is not a catalog plan`);
  if (i === 0) throw new Error("the add-on is free on every plan; there is no fee to state");
  const waivedNames = plans.slice(i).map((p) => p.name);
  const waived = listNames(waivedNames);
  const charged = listNames(plans.slice(0, i).map((p) => p.name));
  const texts = [
    `$${String(monthly)} a month on ${charged}. No fee on ${waived}.`,
    `${waived} also get regulated items at no fee.`,
  ];
  // "the largest plans" is plural: true only while at least two plans waive the fee
  if (waivedNames.length >= 2)
    texts.push(`$${String(monthly)} a month, and no fee on the largest plans.`);
  return texts;
}

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function normalizeText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\$ (\d)/g, "$$$1")
    .replace(/ ([.,!?])/g, "$1")
    .trim();
}

/** The carriers' text and the page without them. The scan counts nested tags of the same name: a plain
 *  non-greedy match stops at the first closing tag and breaks on the price span inside a carrier. */
function splitCarriers(page: string): { texts: string[]; rest: string } {
  const texts: string[] = [];
  let rest = "";
  let pos = 0;
  for (;;) {
    const at = page.indexOf(FEE_MARK, pos);
    if (at < 0) break;
    const open = page.lastIndexOf("<", at);
    const tag = /^<([a-z0-9]+)/i.exec(page.slice(open))?.[1].toLowerCase();
    if (!tag) throw new Error("a fee marker sits outside an element");
    const innerStart = page.indexOf(">", at) + 1;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    re.lastIndex = innerStart;
    let depth = 1;
    let innerEnd = -1;
    let end = -1;
    for (let m = re.exec(page); m; m = re.exec(page)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        innerEnd = m.index;
        end = m.index + m[0].length;
        break;
      }
    }
    if (end < 0) throw new Error(`an unclosed <${tag}> fee carrier`);
    texts.push(normalizeText(page.slice(innerStart, innerEnd)));
    rest += `${page.slice(pos, open)} `;
    pos = end;
  }
  return { texts, rest: rest + page.slice(pos) };
}

const SWEEP_BREAK =
  /<\/?(?:p|li|ul|ol|td|th|tr|table|h[1-6]|div|section|article|header|footer|nav|main|aside|figure|figcaption|summary|details|dt|dd|br|button|a|label|blockquote|title)\b[^>]*>/gi;

function feeSentences(rest: string): string[] {
  const body = rest
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(SWEEP_BREAK, "\n");
  const out: string[] = [];
  for (const chunk of body.split("\n")) {
    const text = normalizeText(chunk);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) if (sentence) out.push(sentence);
  }
  return out;
}

/** Every problem with the fee claim across the given pages (throws when the catalog leaves no fee to state). */
function feeClaimProblems(
  pages: Record<string, string>,
  plans: ReadonlyArray<FeePlan>,
  includedAt: string | null | undefined,
  monthly: unknown,
): string[] {
  const allowed = allowedFeeTexts(plans, includedAt, monthly);
  const feeWords = [
    /no fee on/i,
    /free on/i,
    /largest plans/i,
    /a month on/i,
    ...plans.map((p) => new RegExp(`\\b${p.name}\\b[^.!?]*\\bfee\\b`, "i")),
  ];
  const problems: string[] = [];
  let carriers = 0;
  for (const [name, page] of Object.entries(pages)) {
    const { texts, rest } = splitCarriers(page);
    carriers += texts.length;
    for (const t of texts)
      if (!allowed.includes(t)) problems.push(`${name}: carrier mismatch: "${t}"`);
    for (const sentence of feeSentences(rest)) {
      if (feeWords.some((re) => re.test(sentence))) {
        problems.push(`${name}: sweep: unmarked fee sentence: "${sentence}"`);
      }
    }
  }
  if (carriers === 0) problems.push(`no carrier: no element carries ${FEE_MARK}`);
  return problems;
}

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

  const feePlans = () => catalog.plans as unknown as FeePlan[];
  const feeAt = () => sku("REGULATED_ITEMS")?.includedAtPlan as string | null | undefined;
  const feeMonthly = () => sku("REGULATED_ITEMS")?.monthlyPrice;

  it("the regulated-items fee claim is marked, equals the catalog's text, and appears nowhere unmarked", () => {
    expect(feeAt()).toBe("SCALE"); // kept tripwire: a catalog move re-opens SA-1287
    const byPage: Record<string, string> = {};
    for (const f of pages()) byPage[f] = html(f);
    expect(feeClaimProblems(byPage, feePlans(), feeAt(), feeMonthly())).toEqual([]);
    const carriers = Object.values(byPage).reduce((n, h) => n + splitCarriers(h).texts.length, 0);
    expect(carriers).toBeGreaterThanOrEqual(1);
  });

  describe("the fee claim guard, on planted pages (SA-1287 A1)", () => {
    const price = '$<span data-addon="REGULATED" data-field="monthly">39</span>';
    const mark = (inner: string, tag = "span") => `<${tag} ${FEE_MARK}>${inner}</${tag}>`;
    const T1 = `${price} a month on Starter and Growth. No fee on Scale and Enterprise.`;
    const T3 = `${price} a month, and no fee on the largest plans.`;
    const T2 = "Scale and Enterprise also get regulated items at no fee.";
    const run = (html: string, at: string | null | undefined = "SCALE") =>
      feeClaimProblems({ "planted.html": html }, feePlans(), at, 39);
    const valid = `<li><b>Regulated items</b><small>${mark(T3)}</small></li>`;

    it.each([
      ["master wording (T1)", `<li>We turn it on for you. ${mark(T1)}</li>`],
      ["the one-line wording (T3)", valid],
      ["the home wording (T2) after a lead-in", `<p>The plans differ. ${mark(T2)}</p>`],
      [
        "a true trial sentence beside a valid carrier",
        `<p>The trial is on the Starter plan, and it's free.</p>${valid}`,
      ],
    ])("green: %s", (_n, page) => {
      expect(run(page)).toEqual([]);
    });

    it.each([
      [
        "F1 an extra waiver",
        mark(`${price} a month on Starter. No fee on Growth. No fee on Scale and Enterprise.`),
        /carrier mismatch/,
      ],
      [
        "F2 the wrong charge side",
        mark(`${price} a month on Starter, Growth and Scale. No fee on Scale and Enterprise.`),
        /carrier mismatch/,
      ],
      ["F3a a plan the catalog lacks", mark(`${T3} No fee on Pro.`), /carrier mismatch/],
      ["F3b an every-plan claim", mark(`${T3} Free on every plan.`), /carrier mismatch/],
      [
        "F3c a negated sentence",
        mark(`${price} a month, and not: No fee on Scale and Enterprise.`),
        /carrier mismatch/,
      ],
      [
        "F4 a second fee line, marked",
        `${valid}<li ${FEE_MARK}>No fee on Growth and Scale.</li>`,
        /carrier mismatch/,
      ],
      [
        "L1 the home line names the wrong plans",
        `<p>${mark("Growth, Scale and Enterprise also get regulated items at no fee.")}</p>`,
        /carrier mismatch/,
      ],
    ])("red: %s", (_n, page, re) => {
      expect(run(page).join("\n")).toMatch(re);
    });

    it("red: F4 a second fee line, unmarked, fails the sweep", () => {
      expect(run(`${valid}<li>No fee on Growth and Scale.</li>`).join("\n")).toMatch(
        /sweep: unmarked/,
      );
    });

    it("red: L1 today's product sentence, unmarked, gives two sweep problems", () => {
      const product = `<p>We turn it on for you. It's ${price} a month on Starter and Growth. There's no fee on Scale and Enterprise.</p>`;
      const found = run(`${valid}${product}`).filter((x) => x.includes("sweep: unmarked"));
      expect(found).toHaveLength(2);
    });

    it("red: R1 one waiver makes the plural line false", () => {
      expect(run(`<li>${mark(T3)}</li>`, "ENTERPRISE").join("\n")).toMatch(/carrier mismatch/);
    });

    it("red: R2 the fee is not stated when every plan waives it", () => {
      expect(() => run(valid, "STARTER")).toThrow(/free on every plan/);
    });

    it("red: R3 the included-at plan must be a catalog plan", () => {
      expect(() => run(valid, "PRO")).toThrow(/not a catalog plan/);
    });

    it("red: no carrier anywhere", () => {
      expect(run("<p>The trial is on the Starter plan, and it's free.</p>").join("\n")).toMatch(
        /no carrier/,
      );
    });
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
    // SA-1282: the home plan cards no longer carry the three yearly spans, so the floor is at least 28 spans (was 31).
    expect(seen).toBeGreaterThan(27);
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

  it("no page promises 'no customer limit' while the priced plans on sale carry one", () => {
    const capped = catalog.plans
      .filter((p) => !p.isCustom)
      .every((p) => typeof p.customersIncluded === "number");
    expect(capped).toBe(true);
    const hits = pages().filter((f) => /no customer limit|no limit on customers/i.test(html(f)));
    expect(hits).toEqual([]);
  });
});
