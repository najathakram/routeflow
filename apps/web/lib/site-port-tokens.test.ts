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

  it("whole words only: an identifier that starts with the name is left intact", () => {
    const b = loadBrand();
    const html = `<p>${b.name}Shell and ${b.name}.</p>`;
    expect(tokenise(html, b)).toBe(`<p>${b.name}Shell and {{brand:name}}.</p>`);
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

  it("a brand whose name, formerly and officialName all differ goes red: alternateName is stale", () => {
    const fx = { ...real, name: "Fx Name", formerly: "Fx Former", officialName: "Fx-Official" };
    expect(homeJsonLd(fx)).toContain('"alternateName":["{{brand:name}}","{{brand:formerly}}"]');
    expect(homeJsonLdProblems(home, fx).join("\n")).toContain(
      "regenerate home: alternateName is stale",
    );
  });

  it("alternateName drops duplicates and the official name, and is left out when empty", () => {
    expect(homeJsonLd(real)).not.toContain("alternateName");
    const one = homeJsonLd({ ...real, name: "A", formerly: "A", officialName: "B" });
    expect(one).toContain('"alternateName":["{{brand:name}}"]');
    const none = homeJsonLd({ ...real, name: "A", formerly: "B", officialName: "A" });
    expect(none).toContain('"alternateName":["{{brand:formerly}}"]');
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
