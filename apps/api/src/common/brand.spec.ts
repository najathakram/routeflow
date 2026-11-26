import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BRAND, loadBrand } from "./brand";

const REAL = join(__dirname, "..", "..", "..", "..", "packages", "types", "brand", "brand.json");
const PUBLIC = join(__dirname, "..", "..", "..", "web", "public");

const real = (): Record<string, unknown> => JSON.parse(readFileSync(REAL, "utf8"));

/** A brand.json written to a temp dir, so a bad value never touches the real file. */
function fileWith(mutate: (b: Record<string, unknown>) => void): string {
  const b = real();
  mutate(b);
  const dir = mkdtempSync(join(tmpdir(), "brand-spec-"));
  const file = join(dir, "brand.json");
  writeFileSync(file, JSON.stringify(b));
  return file;
}

const REQUIRED = [
  "name",
  "formerly",
  "origin",
  "emailLogo",
  "emailLogoWidth",
  "emailLogoHeight",
] as const;

describe("common/brand (the API's reader of packages/types/brand/brand.json)", () => {
  it("loads the real file and carries the delta section 1 keys the API uses", () => {
    const file = real();
    for (const key of REQUIRED) expect(BRAND[key]).toEqual(file[key]);
    expect(BRAND.name.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED)("a brand.json without %s throws `brand.json: missing %s`", (key) => {
    const path = fileWith((b) => delete b[key]);
    expect(() => loadBrand(path)).toThrow(`brand.json: missing ${key}`);
  });

  it("rejects http, a trailing slash, a relative or svg logo, and non-integer sizes", () => {
    const bad: Array<[string, (b: Record<string, unknown>) => void]> = [
      ["origin", (b) => (b.origin = "http://www.example.test")],
      ["origin", (b) => (b.origin = "https://www.example.test/")],
      ["emailLogo", (b) => (b.emailLogo = "brand/logo.png")],
      ["emailLogo", (b) => (b.emailLogo = "/brand/logo.svg")],
      ["emailLogoWidth", (b) => (b.emailLogoWidth = 0)],
      ["emailLogoWidth", (b) => (b.emailLogoWidth = 24.5)],
      ["emailLogoHeight", (b) => (b.emailLogoHeight = "24")],
    ];
    for (const [key, mutate] of bad) {
      expect(() => loadBrand(fileWith(mutate))).toThrow(`brand.json: missing ${key}`);
    }
  });

  it("the emailLogo file exists in apps/web/public and is at least the displayed size, same shape", () => {
    const file = join(PUBLIC, BRAND.emailLogo);
    expect(existsSync(file)).toBe(true);
    const png = readFileSync(file);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    expect(w).toBeGreaterThanOrEqual(BRAND.emailLogoWidth);
    expect(h).toBeGreaterThanOrEqual(BRAND.emailLogoHeight);
    expect(Math.abs(w / h - BRAND.emailLogoWidth / BRAND.emailLogoHeight)).toBeLessThan(0.05);
  });

  it("BRAND is frozen", () => {
    expect(Object.isFrozen(BRAND)).toBe(true);
    expect(() => {
      (BRAND as { name: string }).name = "x";
    }).toThrow();
  });
});
