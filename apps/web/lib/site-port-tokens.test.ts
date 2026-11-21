/**
 * @jest-environment node
 */
// scripts/sync-site-port.mjs ports the design source into public/site and must write the same
// {{brand:key}} tokens the committed pages carry, including the source's own typed name in titles,
// body and footer. The design source is machine-local and not in the repo, so this proves the
// mapping the other way round: take each committed tokenised page, fill it with the real brand
// (what the design source types), run the script's tokenise() over it, and expect the committed
// file back byte for byte. A re-run of the script therefore reproduces the pages.
import * as fs from "fs";
import * as path from "path";
import { loadBrand } from "@routeflow/types/brand";
import { renderSitePage } from "./static-site-page";
const { tokenise } = require("../../../scripts/lib/site-port-tokens.cjs") as {
  tokenise: (html: string, brand: ReturnType<typeof loadBrand>) => string;
};

const SITE = path.resolve(__dirname, "../public/site");
const PAGES = [
  "pricing",
  "product",
  "company",
  "contact",
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
];

describe("sync-site-port tokenise", () => {
  it.each(PAGES)("%s: the filled page tokenises back to the committed file", (page) => {
    const committed = fs.readFileSync(path.join(SITE, `${page}.html`), "utf8");
    // null: the page filled with the brand only, no injected palette style (what the design source types)
    const typed = renderSitePage(committed, loadBrand(), null);
    expect(typed).not.toBe(committed);
    expect(tokenise(typed, loadBrand())).toBe(committed);
  });

  it("a fixture snippet: title, body, footer, mailto, icon and share alt all become tokens", () => {
    const b = loadBrand();
    const snippet =
      `<title>Pricing${b.titleSeparator}${b.name}</title>` +
      `<link rel="icon" href="${b.icon.favicon}">` +
      `<meta content="${b.name}. ${b.shareLine}"><a href="mailto:${b.email}">${b.email}</a>` +
      `<p>Try ${b.name} free.</p><span>© 2026 ${b.name}</span><link href="${b.origin}/pricing">`;
    const out = tokenise(snippet, b);
    expect(out).not.toContain(b.name);
    expect(out).not.toContain(b.email);
    expect(out).not.toContain(b.origin);
    expect(renderSitePage(out, b)).toBe(snippet);
  });

  it("an identifier that starts with the name, and is not allow-listed, throws", () => {
    const b = loadBrand();
    expect(() => tokenise(`<p>${b.name}Shell and ${b.name}.</p>`, b)).toThrow(/cannot tokenise/);
  });

  it("the allow-listed identifiers pass untouched next to a bare name, which is tokenised", () => {
    const b = loadBrand();
    // the three identifiers the tokeniser allows, spelled from the previous name the identifiers carry
    const old = b.formerly;
    const allowed = [`${old}Shell`, `${old.toLowerCase()}-v4`, `/brand/${old.toLowerCase()}-mark`];
    expect(allowed).toHaveLength(3);
    // Once under the live name, and once with the previous name as the brand's name: only then does an
    // allowed identifier hold the name, so the tokeniser's allow-list strip is what lets it through.
    for (const brand of [b, { ...b, name: b.formerly }]) {
      for (const id of allowed) {
        expect(tokenise(`<p>${id} and ${brand.name}.</p>`, brand)).toBe(
          `<p>${id} and {{brand:name}}.</p>`,
        );
      }
    }
  });

  it("a name inside a host or path it cannot tokenise throws instead of corrupting", () => {
    const b = loadBrand();
    expect(() => tokenise(`<a href="https://docs.${b.name}.io/x">x</a>`, b)).toThrow(
      /cannot tokenise/,
    );
  });
});

// SA-1178 A1: the home page's structured data is derived in one place (the generator's pure
// function). The committed page must equal it for the current brand, and a value the page renderer
// would HTML-escape (script content is raw text) is refused.
const { homeJsonLd, unsafeJsonLdKeys } = require("../../../scripts/lib/site-port-jsonld.cjs") as {
  homeJsonLd: (brand: ReturnType<typeof loadBrand>) => string;
  unsafeJsonLdKeys: (brand: ReturnType<typeof loadBrand>) => string[];
};
const LD = /<script type="application\/ld\+json">[^<]*<\/script>/;

/** The problems with home.html's committed structured data for a brand ([] when none). */
function homeJsonLdProblems(committedHome: string, brand: ReturnType<typeof loadBrand>): string[] {
  const problems: string[] = [];
  const found = committedHome.match(LD)?.[0];
  if (found !== homeJsonLd(brand)) {
    problems.push(
      "regenerate home: alternateName is stale (the ld+json differs from the generator)",
    );
  }
  for (const key of unsafeJsonLdKeys(brand)) {
    problems.push(`brand key "${key}" holds & < > " or ' and is placed raw in the ld+json script`);
  }
  return problems;
}

describe("home.html structured data (SA-1178)", () => {
  const home = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const real = loadBrand();

  it("equals the generator's output for the current brand.json and holds no unsafe value", () => {
    expect(homeJsonLdProblems(home, real)).toEqual([]);
  });

  it("a brand whose name, formerly and officialName all differ gets both in alternateName, not stale", () => {
    const fx = { ...real, name: "Fx Name", formerly: "Fx Former", officialName: "Fx-Official" };
    // the alternateName the generator builds from this fixture's fields: both distinct values
    const expected = `"alternateName":["{{brand:name}}","{{brand:formerly}}"]`;
    expect(new Set([fx.name, fx.formerly, fx.officialName]).size).toBe(3);
    expect(homeJsonLd(fx)).toContain(expected);
    expect(homeJsonLdProblems(home, fx)).toEqual([]);
  });

  it("alternateName drops duplicates and the official name, and is left out when empty", () => {
    // fixture brands whose values repeat; nothing here reads the real brand.json
    const base = { ...real, name: "Fx A", formerly: "Fx A", officialName: "Fx B" };
    const nameOnly = homeJsonLd(base);
    expect(nameOnly).toContain('"alternateName":["{{brand:name}}"]');
    expect(nameOnly).not.toContain("{{brand:formerly}}");
    const swapped = { ...base, name: "Fx B", formerly: "Fx A", officialName: "Fx B" };
    const formerlyOnly = homeJsonLd(swapped);
    expect(formerlyOnly).toContain('"alternateName":["{{brand:formerly}}"]');
    expect(formerlyOnly).not.toContain('"{{brand:name}}"');
    const empty = homeJsonLd({ ...base, name: "Fx B", formerly: "Fx B", officialName: "Fx B" });
    expect(empty).not.toContain("alternateName");
  });

  it("a brand value with & < > \" or ' in a tokenised key goes red and names the key", () => {
    for (const bad of ["It's simple", "a & b", "x<y", 'say "hi"', "a>b"]) {
      const fx = { ...real, shareLine: bad };
      expect(unsafeJsonLdKeys(fx)).toEqual(["shareLine"]);
      expect(homeJsonLdProblems(home, fx).join("\n")).toContain('brand key "shareLine"');
    }
  });

  it("a key the script does not place is not checked", () => {
    expect(unsafeJsonLdKeys({ ...real, titleSeparator: " &'\" " })).toEqual([]);
  });
});
