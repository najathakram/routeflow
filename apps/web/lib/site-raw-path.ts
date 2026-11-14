// Guards the raw file address of a ready-made page (/site/<page>.html): the file carries unfilled
// {{brand:key}} tokens, and the route (app/site-page) is the only place that fills them.
// next.config.mjs redirects the plain spelling, but its redirects match the ENCODED path while the
// `public/` lookup also tries the decoded one, so `/site/%70ricing.html` skipped the redirect and
// served the raw file. middleware.ts asks this pure function about every request instead: it
// normalises the path the way a file system would read it, then matches it against the same page
// list the route serves (STATIC_SITE_PAGES).
//
// Normal form: the query and hash are dropped; percent-escapes are decoded until the text stops
// changing (so %2570 is caught); a backslash is a slash; repeated slashes and `.`/`..` segments are
// resolved; the text is lower-cased; trailing slashes, dots and spaces are removed. A result of
// `/site/<page>.html` for a page in STATIC_SITE_PAGES is a "page".
//
// A malformed escape (a lone `%`, `%zz`, a broken UTF-8 run): strict decoding fails. The path is
// then read leniently (bad escapes left as they are, then their "%" dropped). If that reading names a page, the answer is
// "malformed" and the middleware answers 400 (a request that hides a page file behind a broken
// escape has no good reading); otherwise "none", and the request goes on unchanged.
import { STATIC_SITE_PAGES, type StaticSitePage } from "@/lib/static-site-pages";

export type SitePathClass =
  { kind: "page"; page: StaticSitePage; clean: string } | { kind: "malformed" } | { kind: "none" };

const MAX_ROUNDS = 8;

/** Decode every valid %XX run; an invalid one is left as it is. */
function lenientDecode(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Decode until stable. `strict` throws on a malformed escape (URIError); lenient never does. */
function decodeToStable(text: string, strict: boolean): string {
  let current = text;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const next = strict ? decodeURIComponent(current) : lenientDecode(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function resolveSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function normalise(decoded: string): string {
  const slashed = decoded.split(String.fromCharCode(92)).join("/");
  return resolveSegments(slashed.toLowerCase())
    .replace(/[\s./]+$/g, "")
    .replace(/^$/, "/");
}

const PAGE_FILE = /^\/site\/([a-z0-9-]+)\.html$/;

function pageOf(normalised: string): StaticSitePage | null {
  const name = PAGE_FILE.exec(normalised)?.[1];
  return name && Object.prototype.hasOwnProperty.call(STATIC_SITE_PAGES, name)
    ? (name as StaticSitePage)
    : null;
}

/** What a request path (as received, encoded, with or without a query) asks for. */
export function classifySitePath(rawPath: string): SitePathClass {
  const path = rawPath.split(/[?#]/, 1)[0] ?? "";
  let strictFailed = false;
  let decoded: string;
  try {
    decoded = decodeToStable(path, true);
  } catch {
    strictFailed = true;
    // A stray "%" is no part of a page name: read the path without it.
    decoded = decodeToStable(path, false).replace(/%/g, "");
  }
  const page = pageOf(normalise(decoded));
  if (!page) return { kind: "none" };
  if (strictFailed) return { kind: "malformed" };
  return { kind: "page", page, clean: STATIC_SITE_PAGES[page] };
}
