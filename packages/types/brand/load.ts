// The one reader of brand.json. Everything that names the brand goes through loadBrand(); tests
// mock this module (jest.mock("@routeflow/types/brand/load")) to inject a fixture brand, which is
// why index.ts, the static-page renderer and every consumer call it rather than importing the JSON.
// Web only: the API reads the same file through its own common/brand.ts (no runtime import).
import brandJson from "./brand.json";
import paletteJson from "./palette.json";

export interface Brand {
  readonly name: string;
  /** The full legal-style product name (structured data only). Equal to `name` while there is one name. */
  readonly officialName: string;
  /** The previous name. Equal to `name` means "no former-name line". */
  readonly formerly: string;
  readonly legalEntity: string;
  readonly origin: string;
  readonly oldOrigin: string;
  readonly email: string;
  readonly securityEmail: string;
  readonly titleSeparator: string;
  readonly shareLine: string;
  readonly logo: { readonly onLight: string; readonly onDark: string; readonly small: string };
  readonly symbol: string;
  /** The symbol drawn on a dark surface (the wheel hub and its still). `symbol` is for light ones. */
  readonly symbolOnDark: string;
  readonly icon: {
    readonly favicon: string;
    readonly apple: string;
    readonly "192": string;
    readonly "512": string;
  };
  readonly emailLogo: string;
  /** The email logo's size in px. 24 x 24 today; the flip sets the real logo's size. */
  readonly emailLogoWidth: number;
  readonly emailLogoHeight: number;
}

/** Every key a brand must carry, dotted for the nested ones. The reader checks each. */
export const BRAND_KEYS = [
  "name",
  "officialName",
  "formerly",
  "legalEntity",
  "origin",
  "oldOrigin",
  "email",
  "securityEmail",
  "titleSeparator",
  "shareLine",
  "logo.onLight",
  "logo.onDark",
  "logo.small",
  "symbol",
  "symbolOnDark",
  "icon.favicon",
  "icon.apple",
  "icon.192",
  "icon.512",
  "emailLogo",
] as const;

/** Keys that must be positive integers (sizes). The reader checks each. */
export const BRAND_NUMBER_KEYS = ["emailLogoWidth", "emailLogoHeight"] as const;

/** The value at a dotted key, or undefined. */
export function brandValue(brand: unknown, key: string): unknown {
  let at: unknown = brand;
  for (const part of key.split(".")) {
    if (at === null || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) {
      return undefined;
    }
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** Checks every key (a non-empty string; the title separator may be any non-empty string) and
 *  returns a frozen copy. Throws naming the first missing or empty key (or a size that is not a
 *  positive integer). */
export function validateBrand(raw: unknown): Brand {
  for (const key of BRAND_KEYS) {
    const value = brandValue(raw, key);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`brand.json: missing or empty key "${key}"`);
    }
  }
  for (const key of BRAND_NUMBER_KEYS) {
    const value = brandValue(raw, key);
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`brand.json: key "${key}" must be a positive integer`);
    }
  }
  const r = raw as Record<string, Record<string, string> | string>;
  const copy = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  for (const v of Object.values(copy)) {
    if (v !== null && typeof v === "object") Object.freeze(v);
  }
  return Object.freeze(copy) as unknown as Brand;
}

let cached: Brand | undefined;

/** The validated brand. Mockable: see the header. */
export function loadBrand(): Brand {
  cached ??= validateBrand(brandJson);
  return cached;
}

export interface Palette {
  /** `--brand-<key>` -> hex value. Keys are lower-case words joined by hyphens. */
  readonly color: Readonly<Record<string, string>>;
}

const PALETTE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PALETTE_VALUE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Checks palette.json (`color`: a non-empty object of key -> hex) and returns a frozen copy. Keys
 *  and values are restricted so the CSS built from them can never carry markup. */
export function validatePalette(raw: unknown): Palette {
  const color = (raw as { color?: unknown } | null)?.color;
  if (color === null || typeof color !== "object" || Object.keys(color).length === 0) {
    throw new Error('palette.json: missing or empty "color"');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(color as Record<string, unknown>)) {
    if (!PALETTE_KEY.test(key) || typeof value !== "string" || !PALETTE_VALUE.test(value)) {
      throw new Error(
        `palette.json: bad colour "${key}" (a hyphenated lower-case key and a hex value)`,
      );
    }
    out[key] = value;
  }
  return Object.freeze({ color: Object.freeze(out) });
}

let cachedPalette: Palette | undefined;

/** The validated palette. Mockable like loadBrand(). */
export function loadPalette(): Palette {
  cachedPalette ??= validatePalette(paletteJson);
  return cachedPalette;
}

/** The palette as the one `:root{--brand-<key>:<value>;...}` block. Data driven: a new palette needs
 *  no code change. */
export function paletteCss(palette: Palette): string {
  const decls = Object.entries(palette.color).map(([key, value]) => `--brand-${key}:${value};`);
  return `:root{${decls.join("")}}`;
}
