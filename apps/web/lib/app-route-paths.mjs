// The one walker over apps/web/app: every route file and Next metadata file, as the address it
// serves. A plain .mjs module because next.config.mjs cannot import TypeScript; the config
// (deriveStays) and the census test import it, so there is no second walker. Pure reads, nothing is
// written.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Which files are metadata conventions, and where Next serves them, comes from Next itself (no
// table of ours): is-metadata-route.js knows the names, the numbered variants, the extension of each
// and the page extensions; get-metadata-route.js turns a page into its served route (the hash under
// a group or @slot, /robots.txt, /manifest.webmanifest, /sitemap.xml); segment.js knows a group or
// parallel-route folder. If an upgrade renames any of them, loading this module (so the config, so
// the build) throws, never silently.
const metadataRoute = require("next/dist/lib/metadata/is-metadata-route");
const metadataPath = require("next/dist/lib/metadata/get-metadata-route");
const segment = require("next/dist/shared/lib/segment");

export const NEXT_HELPERS = {
  isMetadataRouteFile: metadataRoute.isMetadataRouteFile,
  STATIC_METADATA_IMAGES: metadataRoute.STATIC_METADATA_IMAGES,
  DEFAULT_METADATA_ROUTE_EXTENSIONS: metadataRoute.DEFAULT_METADATA_ROUTE_EXTENSIONS,
  normalizeMetadataRoute: metadataPath.normalizeMetadataRoute,
  normalizeMetadataPageToRoute: metadataPath.normalizeMetadataPageToRoute,
  isGroupSegment: segment.isGroupSegment,
  isParallelRouteSegment: segment.isParallelRouteSegment,
};

/** Throws, naming the first missing one, unless every Next helper this walker needs is there. */
export function assertNextHelpers(mods) {
  for (const name of Object.keys(NEXT_HELPERS)) {
    if (!mods?.[name]) throw new Error(`next metadata helper "${name}" is missing: rule it first`);
  }
}
assertNextHelpers(NEXT_HELPERS);

const {
  isMetadataRouteFile,
  STATIC_METADATA_IMAGES,
  DEFAULT_METADATA_ROUTE_EXTENSIONS,
  normalizeMetadataRoute,
  normalizeMetadataPageToRoute,
  isGroupSegment,
  isParallelRouteSegment,
} = NEXT_HELPERS;

/** The app directory this module sits beside. */
export const APP_DIR = path.join(__dirname, "..", "app");

const PAGE_EXTENSIONS = DEFAULT_METADATA_ROUTE_EXTENSIONS;
const CODE_EXTENSION = new RegExp(`\\.(${PAGE_EXTENSIONS.join("|")})$`);
const ROUTE_FILE = new RegExp(`^(page|route)\\.(${PAGE_EXTENSIONS.join("|")})$`);
const isGroupOrSlot = (name) => isGroupSegment(name) || isParallelRouteSegment(name);
const readDirents = (dir) => readdirSync(dir, { withFileTypes: true });
const readText = (file) => readFileSync(file, "utf8");

// A favicon outside the app root is not a convention Next serves; it is still refused by name, so a
// misplaced one fails the build instead of crossing silently.
const favicon = STATIC_METADATA_IMAGES.favicon;
const isFaviconName = (name) =>
  favicon.extensions.some((ext) => name === `${favicon.filename}.${ext}`);

// A generator that Next serves under an id instead of at its plain path: an export (function,
// const, let, var or export list) named generateImageMetadata or generateSitemaps.
const MULTI_EXPORT =
  /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s*(generateImageMetadata|generateSitemaps)\b|\bexport\s*\{[^}]*\b(generateImageMetadata|generateSitemaps)\b[^}]*\}/;

/** The path Next serves a metadata file at (groups and slots removed; a hash is kept). */
function servedPath(file) {
  const page = `/${file.replace(CODE_EXTENSION, "")}`;
  const route = normalizeMetadataPageToRoute(normalizeMetadataRoute(page), false);
  return `/${route
    .replace(/\/route$/, "")
    .split("/")
    .filter((part) => part && !isGroupOrSlot(part))
    .join("/")}`;
}

/**
 * Every route under `appDir` as `{ path, file, group, metadata }`: `path` is the address with route
 * groups removed and any `[param]` segment kept as written (for a metadata file, the path Next
 * serves); `file` is the posix path below `appDir`; `group` is the top route group or folder ("" at
 * the app root); `metadata` is true for a metadata file. A parallel-route folder (`@slot`) is walked
 * like a route group: it adds no segment. A root metadata code file whose source exports
 * generateImageMetadata or generateSitemaps throws: Next serves it under an id, not at its path.
 * @param {string} [appDir]
 * @param {(dir: string) => Array<{ name: string, isDirectory(): boolean }>} [readdir] injectable, so
 *   a test can walk an in-memory tree
 * @param {(file: string) => string} [readSource] injectable, the source of a metadata code file
 * @returns {Array<{ path: string, file: string, group: string, metadata: boolean }>}
 */
export function listAppRoutes(appDir = APP_DIR, readdir = readDirents, readSource = readText) {
  const out = [];
  const walk = (dir, segments, group) => {
    for (const entry of readdir(dir)) {
      const file = [...segments.files, entry.name].join("/");
      if (entry.isDirectory()) {
        const own = isGroupOrSlot(entry.name) ? [] : [entry.name];
        walk(
          path.join(dir, entry.name),
          { files: [...segments.files, entry.name], path: [...segments.path, ...own] },
          group || entry.name,
        );
      } else if (ROUTE_FILE.test(entry.name)) {
        out.push({ path: `/${segments.path.join("/")}`, file, group, metadata: false });
      } else if (
        isMetadataRouteFile(`/${file}`, PAGE_EXTENSIONS, true) ||
        isFaviconName(entry.name)
      ) {
        if (segments.files.length === 0 && CODE_EXTENSION.test(entry.name)) {
          const used = MULTI_EXPORT.exec(readSource(path.join(dir, entry.name)));
          if (used) {
            throw new Error(
              `${file}: exports ${used[1] ?? used[2]}, so it is served under an id, not at one path (rule it first)`,
            );
          }
        }
        out.push({ path: servedPath(file), file, group, metadata: true });
      }
    }
  };
  walk(appDir, { files: [], path: [] }, "");
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The addresses of the routes that stay on the main host by place: every route under (marketing)
 * and every metadata file at the app root (favicon, robots, sitemap, manifest, numbered icons,
 * generators without generateImageMetadata or generateSitemaps), each at the exact path Next serves.
 * Fails closed, at config load: a `[param]` segment under (marketing); a metadata file anywhere but
 * the app root (nested, or under a group or @slot, so its path is nested or hashed).
 * @param {Array<{ path: string, file: string, group: string, metadata: boolean }>} routes
 * @returns {string[]}
 */
export function placeStays(routes) {
  const stays = [];
  for (const route of routes) {
    if (route.metadata) {
      if (route.file.includes("/")) {
        throw new Error(
          `${route.file}: a metadata file is served only from the app root (rule it first)`,
        );
      }
      stays.push(route.path);
      continue;
    }
    if (route.group !== "(marketing)") continue;
    if (route.path.includes("[")) {
      throw new Error(`${route.file}: a dynamic segment cannot stay by place (rule it first)`);
    }
    stays.push(route.path);
  }
  return stays;
}
