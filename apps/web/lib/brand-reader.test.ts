/**
 * @jest-environment node
 */
// The web reader of the brand seam (packages/types/brand): every key checked, a missing one named,
// titles within the search cut-off, no sentence ending with the name.
import * as fs from "fs";
import * as path from "path";
import {
  BRAND,
  BRAND_KEYS,
  MAX_TITLE_LENGTH,
  BRAND_NUMBER_KEYS,
  brandValue,
  footerLine,
  loadPalette,
  pageTitle,
  paletteCss,
  validateBrand,
  validatePalette,
} from "@routeflow/types/brand";

const JSON_PATH = path.resolve(__dirname, "../../../packages/types/brand/brand.json");
const raw = () => JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as Record<string, unknown>;

describe("brand.json", () => {
  it("carries every key the reader needs, and nothing the reader does not know", () => {
    const file = raw();
    for (const key of BRAND_KEYS) expect(typeof brandValue(file, key)).toBe("string");
    const top = new Set([...BRAND_KEYS, ...BRAND_NUMBER_KEYS].map((k) => k.split(".")[0]));
    expect(Object.keys(file).sort()).toEqual([...top].sort());
  });

  it("BRAND is the validated, frozen file", () => {
    expect(BRAND.name).toBe(raw().name);
    expect(Object.isFrozen(BRAND)).toBe(true);
    expect(Object.isFrozen(BRAND.logo)).toBe(true);
  });
});

describe("validateBrand", () => {
  it.each([...BRAND_KEYS])("throws naming the missing key %s", (key) => {
    const broken = raw();
    const parts = key.split(".");
    let at = broken as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>;
    delete at[parts[parts.length - 1] as string];
    expect(() => validateBrand(broken)).toThrow(`"${key}"`);
  });

  it("the two keys of the name swap are required: symbolOnDark (the reversed symbol) and officialName", () => {
    expect(BRAND_KEYS).toContain("symbolOnDark");
    expect(BRAND_KEYS).toContain("officialName");
    for (const key of ["symbolOnDark", "officialName"]) {
      const broken = raw();
      delete broken[key];
      expect(() => validateBrand(broken)).toThrow(`"${key}"`);
    }
  });

  it("officialName carries no U+2011 (metadata uses the plain hyphen)", () => {
    expect(String(raw().officialName)).not.toContain("‑");
  });

  it("throws on an empty or non-string value, and on a missing nested object", () => {
    expect(() => validateBrand({ ...raw(), name: "" })).toThrow('"name"');
    expect(() => validateBrand({ ...raw(), origin: 3 })).toThrow('"origin"');
    expect(() => validateBrand({ ...raw(), logo: undefined })).toThrow('"logo.onLight"');
    expect(() => validateBrand(null)).toThrow('"name"');
  });
});

describe("pageTitle and footerLine", () => {
  const PAGES = [
    "Product",
    "Pricing",
    "Company",
    "Contact",
    "Getting started",
    "What it does and doesn’t do",
    "Data in and out",
    "Security and your data",
  ];

  it.each(PAGES)("%s: within 60 characters and not a sentence ending with the name", (page) => {
    const title = pageTitle(page);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title).toBe(`${page}${BRAND.titleSeparator}${BRAND.name}`);
    expect(title).not.toMatch(new RegExp(`[.!?]\\s*${BRAND.name}$|${BRAND.name}[.!?]$`));
  });

  it("no page gives the bare name; a title over 60 characters is refused", () => {
    expect(pageTitle()).toBe(BRAND.name);
    expect(() => pageTitle("x".repeat(70))).toThrow(/over 60/);
  });

  // SA-1203 A1: D5 names the previous name in the footer line while it is set and differs
  it("the footer line follows D5", () => {
    expect(footerLine()).toBe(`© 2026 ${BRAND.name}, formerly ${BRAND.formerly}`);
    expect(footerLine(2030)).toBe(`© 2030 ${BRAND.name}, formerly ${BRAND.formerly}`);
    expect(footerLine(2026, { ...BRAND, formerly: BRAND.name })).toBe(`© 2026 ${BRAND.name}`);
    expect(footerLine(2026, { ...BRAND, formerly: "" })).toBe(`© 2026 ${BRAND.name}`);
  });
});

describe("emailLogoWidth and emailLogoHeight", () => {
  it("are positive integers in brand.json (24 x 24 until the flip) and on BRAND", () => {
    const file = raw();
    expect(file.emailLogoWidth).toBe(24);
    expect(file.emailLogoHeight).toBe(24);
    expect(BRAND.emailLogoWidth).toBe(24);
    expect(BRAND.emailLogoHeight).toBe(24);
  });

  it.each([...BRAND_NUMBER_KEYS])("%s: a missing key throws naming it", (key) => {
    const broken = raw();
    delete broken[key];
    expect(() => validateBrand(broken)).toThrow(`"${key}"`);
  });

  it.each([...BRAND_NUMBER_KEYS])(
    "%s: zero, negative, fractional or text throws naming it",
    (key) => {
      for (const bad of [0, -3, 2.5, "24", null, Number.NaN]) {
        expect(() => validateBrand({ ...raw(), [key]: bad })).toThrow(`"${key}"`);
      }
    },
  );
});

describe("the palette reader", () => {
  const PALETTE = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../packages/types/brand/palette.json"), "utf8"),
  ) as { color: Record<string, string> };

  it("loadPalette is the validated, frozen palette.json colours", () => {
    const palette = loadPalette();
    expect(palette.color).toEqual(PALETTE.color);
    expect(Object.isFrozen(palette)).toBe(true);
    expect(Object.isFrozen(palette.color)).toBe(true);
  });

  it("paletteCss is one :root block with --brand-<key>:<value> per colour, in file order", () => {
    const css = paletteCss(loadPalette());
    expect(css.match(/:root\{/g)).toHaveLength(1);
    expect(css).toBe(
      `:root{${Object.entries(PALETTE.color)
        .map(([k, v]) => `--brand-${k}:${v};`)
        .join("")}}`,
    );
  });

  it("refuses a palette with no colours, a bad key or a value that is not a hex colour", () => {
    expect(() => validatePalette(null)).toThrow(/palette\.json/);
    expect(() => validatePalette({ color: {} })).toThrow(/palette\.json/);
    expect(() => validatePalette({ color: { "Bad Key": "#000000" } })).toThrow('"Bad Key"');
    expect(() => validatePalette({ color: { ink: "red" } })).toThrow('"ink"');
    expect(() => validatePalette({ color: { ink: "#000;}</style><script>" } })).toThrow('"ink"');
  });
});
