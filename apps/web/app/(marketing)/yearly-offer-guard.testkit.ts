// Test support, not a route: the yearly-offer guard the site pricing tests and the guard's own spec share.
// It keys on RF_PRICES.yearlyOffer (public/site/js/prices.js), never on a word in billing.service.ts.
import * as fs from "fs";
import * as path from "path";

export type ScanFile = { name: string; text: string };

export type GuardInput = {
  yearlyOffer: boolean;
  billingSource: string;
  files: ScanFile[];
  /** Sources of the specs that guard the offer; none may be skipped while the offer is open. */
  specSources?: string[];
  /** docs/product/claims-register.md text; every yearly row must be `live` while the offer is open. */
  claimsRegister?: string;
};

/** Wording that offers or prices a year, read after normalising (see `normalise`). */
const OFFER =
  /\ba year\b|\beach year\b|\bper year\b|\byearly\b|\bannual(?:ly)?\b|\bper annum\b|\b12 months\b|\btwelve months\b|\bmonths? free\b|\/ ?yr\b/g;

/** Sentences already on a page that a later PR owns. Exact text, one row per page. */
export const KNOWN_OFFER_TEXT: Record<string, string[]> = {
  // PR-T rewrites the terms sentences (SA-1304); until it merges they stay and are the only ones allowed. The second
  // is the liability cap, not an offer.
  "terms/page.tsx": ["monthly/annual, as selected", "in the 12 months preceding the claim"],
};

/** Entities and tags decoded away so `a&nbsp;year` and `a<br>year` read as "a year". */
export function normalise(text: string): string {
  return text
    .replace(/&nbsp;|&#160;|\u00a0/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function walk(dir: string, keep: (rel: string) => boolean, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory())
      return e.name === "node_modules" || e.name === "vendor" ? [] : walk(dir, keep, r);
    return keep(r) ? [r] : [];
  });
}

/** Every file a customer can read words from: site html (any depth) and js, marketing lib and page.tsx. */
export function collectScanFiles(siteDir: string, marketingDir: string): ScanFile[] {
  const read = (root: string, rel: string, prefix = "") => ({
    name: `${prefix}${rel}`,
    text: fs.readFileSync(path.join(root, rel), "utf8"),
  });
  return [
    ...walk(siteDir, (r) => /\.(html|js)$/.test(r)).map((r) => read(siteDir, r)),
    ...walk(marketingDir, (r) => /^lib\/[^/]+\.ts$/.test(r) || /(^|\/)page\.tsx$/.test(r)).map(
      (r) => read(marketingDir, r),
    ),
  ];
}

export function yearlyOfferViolations(input: GuardInput): string[] {
  const bad: string[] = [];
  if (input.yearlyOffer) {
    if (/API_ERROR_CODES\.(CHECKOUT|ADDON)_ANNUAL_NOT_SUPPORTED/.test(input.billingSource)) {
      bad.push("yearlyOffer is true but billing.service.ts still has a refusal throw site");
    }
    for (const s of input.specSources ?? []) {
      if (/\b(?:it|test|describe)\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(/.test(s)) {
        bad.push("yearlyOffer is true but a guard spec is skipped");
      }
    }
    for (const row of (input.claimsRegister ?? "").split("\n")) {
      const cells = row.split("|").map((c) => c.trim());
      if (cells.length > 4 && /year|annual/i.test(cells[1]) && cells[3] !== "`live`") {
        bad.push(`yearlyOffer is true but a claims row is not live: ${cells[1].slice(0, 60)}`);
      }
    }
    return bad;
  }
  for (const f of input.files) {
    // prices.js is the data file: its yearly figures are data, not words a page shows.
    if (f.name === "js/prices.js") continue;
    let text = normalise(f.text);
    for (const ok of KNOWN_OFFER_TEXT[f.name] ?? []) text = text.split(ok).join(" ");
    for (const m of text.matchAll(OFFER)) {
      const at = m.index ?? 0;
      bad.push(`${f.name}: ...${text.slice(Math.max(0, at - 30), at + 30)}...`);
    }
    if (/data-field="yearly"/.test(f.text)) bad.push(`${f.name}: data-field="yearly" span`);
  }
  return bad;
}
