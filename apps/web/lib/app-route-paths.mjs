// The one walker over apps/web/app: every route file and Next metadata file, as the address it
// serves. A plain .mjs module because next.config.mjs cannot import TypeScript; the static tests
// import it too, so there is no second walker. Pure reads, nothing is written.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The app directory this module sits beside. */
export const APP_DIR = path.join(__dirname, "..", "app");

const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;
// Next's metadata conventions (a code file or a static file). At the app root, robots and sitemap
// serve a fixed address; every other one is served at a hashed address.
const METADATA_FILE =
  /^(robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(tsx|ts|jsx|js|txt|xml|json|webmanifest|ico|png|jpg|jpeg|gif|svg)$/;
const FIXED_ROOT_ADDRESS = { robots: "/robots.txt", sitemap: "/sitemap.xml" };

/**
 * Every route under `appDir` as `{ path, file, group, metadata }`: `path` is the address with route
 * groups removed and any `[param]` segment kept as written; `file` is the posix path below `appDir`;
 * `group` is the top route group or folder ("" at the app root); `metadata` is true for a metadata
 * file. Parallel-route folders (`@slot`) serve no address of their own and are skipped.
 * @param {string} [appDir]
 * @returns {Array<{ path: string, file: string, group: string, metadata: boolean }>}
 */
export function listAppRoutes(appDir = APP_DIR) {
  const out = [];
  const walk = (dir, segments, group) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = [...segments.files, entry.name].join("/");
      if (entry.isDirectory()) {
        if (entry.name.startsWith("@")) continue;
        const own = /^\(.*\)$/.test(entry.name) ? [] : [entry.name];
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
 * and the app-root robots and sitemap. Fails closed: a `[param]` segment under (marketing), or a
 * metadata file (hashed address) in either place other than robots and sitemap, throws, because its
 * address cannot be matched exactly.
 * @param {Array<{ path: string, file: string, group: string, metadata: boolean }>} routes
 * @returns {string[]}
 */
export function placeStays(routes) {
  const stays = [];
  for (const route of routes) {
    const marketing = route.group === "(marketing)";
    const rootMetadata = route.group === "" && route.metadata;
    if (!marketing && !rootMetadata) continue;
    if (route.path.includes("[")) {
      throw new Error(`${route.file}: a dynamic segment cannot stay by place (rule it first)`);
    }
    const fixed = route.path === "/robots.txt" || route.path === "/sitemap.xml";
    if (route.metadata && !fixed) {
      throw new Error(`${route.file}: a metadata file has a hashed address (rule it first)`);
    }
    stays.push(route.path);
  }
  return stays;
}
