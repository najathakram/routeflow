import { readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * The API's one reader of the brand store, `packages/types/brand/brand.json` (data only; the web
 * app reads the same file through `@routeflow/types/brand`). It reads the JSON from disk instead of
 * importing the package: `@routeflow/types` ships raw TypeScript (`main: ./index.ts`), so a value
 * import would become a `require()` in `dist/` and crash boot (`no-runtime-workspace-imports.spec.ts`).
 * `require.resolve` of the package file works both under Jest and in the image, which carries
 * `packages/`. Every name, logo URL and site link in mail comes from `BRAND`, never a typed literal.
 *
 * The file is validated once at module load, so a missing or malformed key fails the boot of the
 * API and never a send in the middle of a request.
 */
export interface ApiBrand {
  /** The product name as people read it. */
  readonly name: string;
  /** The previous name; equal to `name` means "no former-name line". */
  readonly formerly: string;
  /** The public site, `https://` and no trailing slash. */
  readonly origin: string;
  /** The mail logo's path under `origin`: a leading slash, a PNG (mail clients draw no SVG). */
  readonly emailLogo: string;
  /** The mail logo's displayed size in px. */
  readonly emailLogoWidth: number;
  readonly emailLogoHeight: number;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Reads and validates one brand.json. Throws `brand.json: missing <key>` for the first bad key. */
export function loadBrand(path: string): ApiBrand {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const bad = (key: string): never => {
    throw new Error(`brand.json: missing ${key}`);
  };
  const { name, formerly, origin, emailLogo, emailLogoWidth, emailLogoHeight } = raw;
  if (!isText(name)) bad("name");
  if (!isText(formerly)) bad("formerly");
  if (!isText(origin) || !origin.startsWith("https://") || origin.endsWith("/")) bad("origin");
  if (!isText(emailLogo) || !emailLogo.startsWith("/") || !emailLogo.endsWith(".png")) {
    bad("emailLogo");
  }
  if (!isSize(emailLogoWidth)) bad("emailLogoWidth");
  if (!isSize(emailLogoHeight)) bad("emailLogoHeight");
  return Object.freeze({
    name,
    formerly,
    origin,
    emailLogo,
    emailLogoWidth,
    emailLogoHeight,
  } as ApiBrand);
}

export const BRAND: ApiBrand = loadBrand(
  join(dirname(require.resolve("@routeflow/types/package.json")), "brand", "brand.json"),
);
