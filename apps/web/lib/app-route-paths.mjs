// The one walker over apps/web/app: every route file and Next metadata file, as the address it
// serves. A plain .mjs module because next.config.mjs cannot import TypeScript; the config
// (deriveStays) and the census test import it, so there is no second walker. Pure reads, nothing is
// written.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The app directory this module sits beside. */
export const APP_DIR = path.join(__dirname, "..", "app");

const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;
// Next's whole metadata set (a code file or a static file). At the app root, favicon, robots and
// sitemap serve a fixed address; every other one is served at a hashed address.
const METADATA_FILE =
  /^(favicon|robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(tsx|ts|jsx|js|txt|xml|json|webmanifest|ico|png|jpg|jpeg|gif|svg)$/;
export const FIXED_ROOT_ADDRESS = {
  favicon: "/favicon.ico",
  robots: "/robots.txt",
  sitemap: "/sitemap.xml",
};
const readDirents = (dir) => readdirSync(dir, { withFileTypes: true });

/**
 * Every route under `appDir` as `{ path, file, group, metadata }`: `path` is the address with route
 * groups removed and any `[param]` segment kept as written; `file` is the posix path below `appDir`;
 * `group` is the top route group or folder ("" at the app root); `metadata` is true for a metadata
 * file. A parallel-route folder (`@slot`) is walked like a route group: it adds no segment.
 * @param {string} [appDir]
 * @param {(dir: string) => Array<{ name: string, isDirectory(): boolean }>} [readdir] injectable, so
 *   a test can walk an in-memory tree
 * @returns {Array<{ path: string, file: string, group: string, metadata: boolean }>}
 */
export function listAppRoutes(appDir = APP_DIR, readdir = readDirents) {
  const out = [];
  const walk = (dir, segments, group) => {
    for (const entry of readdir(dir)) {
      const file = [...segments.files, entry.name].join("/");
      if (entry.isDirectory()) {
        const own = /^\(.*\)$/.test(entry.name) || entry.name.startsWith("@") ? [] : [entry.name];
        walk(
          path.join(dir, entry.name),
          { files: [...segments.files, entry.name], path: [...segments.path, ...own] },
          group || entry.name,
        );
      } else if (ROUTE_FILE.test(entry.name)) {
        out.push({ path: `/${segments.path.join("/")}`, file, group, metadata: false });
      } else if (METADATA_FILE.test(entry.name)) {
        const name = entry.name.replace(/\..*$/, "");
        const fixed = segments.path.length === 0 ? FIXED_ROOT_ADDRESS[name] : undefined;
        out.push({
          path: fixed ?? `/${[...segments.path, name].join("/")}`,
          file,
          group,
          metadata: true,
        });
      }
    }
  };
  walk(appDir, { files: [], path: [] }, "");
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The addresses of the routes that stay on the main host by place: every route under (marketing)
 * and the app-root favicon, robots and sitemap (the fixed addresses). Fails closed: a `[param]`
 * segment under (marketing), a metadata file with a hashed address in either place, or a favicon
 * anywhere but the app root, throws, because its address cannot be matched exactly.
 * @param {Array<{ path: string, file: string, group: string, metadata: boolean }>} routes
 * @returns {string[]}
 */
export function placeStays(routes) {
  const fixedAddresses = Object.values(FIXED_ROOT_ADDRESS);
  const stays = [];
  for (const route of routes) {
    if (route.metadata && /(^|\/)favicon\.[^/]+$/.test(route.file) && route.file.includes("/")) {
      throw new Error(`${route.file}: a favicon is served only from the app root (rule it first)`);
    }
    const marketing = route.group === "(marketing)";
    const rootMetadata = route.group === "" && route.metadata;
    if (!marketing && !rootMetadata) continue;
    if (route.path.includes("[")) {
      throw new Error(`${route.file}: a dynamic segment cannot stay by place (rule it first)`);
    }
    if (route.metadata && !(rootMetadata && fixedAddresses.includes(route.path))) {
      throw new Error(`${route.file}: a metadata file has a hashed address (rule it first)`);
    }
    stays.push(route.path);
  }
  return stays;
}
