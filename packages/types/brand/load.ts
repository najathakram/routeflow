// The one reader of brand.json. Everything that names the brand goes through loadBrand(); tests
// mock this module (jest.mock("@routeflow/types/brand/load")) to inject a fixture brand, which is
// why index.ts, the static-page renderer and every consumer call it rather than importing the JSON.
// Web only: the API reads the same file through its own common/brand.ts (no runtime import).
import brandJson from "./brand.json";

export interface Brand {
  readonly name: string;
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
  readonly icon: {
    readonly favicon: string;
    readonly apple: string;
    readonly "192": string;
    readonly "512": string;
  };
  readonly emailLogo: string;
}

/** Every key a brand must carry, dotted for the nested ones. The reader checks each. */
export const BRAND_KEYS = [
  "name",
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
  "icon.favicon",
  "icon.apple",
  "icon.192",
  "icon.512",
  "emailLogo",
] as const;

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
 *  returns a frozen copy. Throws naming the first missing or empty key. */
export function validateBrand(raw: unknown): Brand {
  for (const key of BRAND_KEYS) {
    const value = brandValue(raw, key);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`brand.json: missing or empty key "${key}"`);
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
