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
  brandValue,
  footerLine,
  pageTitle,
  validateBrand,
} from "@routeflow/types/brand";

const JSON_PATH = path.resolve(__dirname, "../../../packages/types/brand/brand.json");
const raw = () => JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as Record<string, unknown>;

describe("brand.json", () => {
  it("carries every key the reader needs, and nothing the reader does not know", () => {
    const file = raw();
    for (const key of BRAND_KEYS) expect(typeof brandValue(file, key)).toBe("string");
    const top = new Set(BRAND_KEYS.map((k) => k.split(".")[0]));
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

  it("the footer line is the year and the name", () => {
    expect(footerLine()).toBe(`© 2026 ${BRAND.name}`);
    expect(footerLine(2030)).toBe(`© 2030 ${BRAND.name}`);
  });
});
