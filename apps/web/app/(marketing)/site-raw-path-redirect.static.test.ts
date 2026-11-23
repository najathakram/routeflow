/**
 * @jest-environment node
 */
// A ready-made page that carries {{brand:key}} tokens is only complete after app/site-page fills
// them. Asked for by its file name (/site/<page>.html) it would be served raw, tokens and all, so
// every such page needs a redirect to its clean address. When a later lane tokenises another page
// (home, landing) this test fails until next.config.mjs redirects that page too.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");
const SITE = path.join(WEB_ROOT, "public", "site");

interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: unknown;
}

function loadRedirects(): Redirect[] {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.redirects()));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    }),
  ) as Redirect[];
}

/** The address a page is served at: home is "/", every other page its own name. */
const cleanPath = (page: string) => (page === "home" ? "/" : `/${page}`);

const tokenised = fs
  .readdirSync(SITE)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -".html".length))
  .filter((page) => /\{\{brand:/i.test(fs.readFileSync(path.join(SITE, `${page}.html`), "utf8")))
  .sort();

describe("raw /site/<page>.html of a tokenised page", () => {
  it("there are tokenised pages to check", () => {
    expect(tokenised.length).toBeGreaterThanOrEqual(8);
  });

  it.each(tokenised)("%s redirects (307) to its clean address", (page) => {
    const rule = loadRedirects().find((r) => r.source === `/site/${page}.html` && !r.has);
    expect(rule).toEqual({
      source: `/site/${page}.html`,
      destination: cleanPath(page),
      permanent: false,
    });
  });

  it("no page, script or the service worker links to a raw page file", () => {
    const pages =
      "home|pricing|product|landing|company|contact|getting-started|does-and-doesnt|data-in-and-out|security";
    const raw = new RegExp(`/site/(${pages})\\.html`);
    const files = [
      ...fs
        .readdirSync(SITE)
        .filter((f) => f.endsWith(".html"))
        .map((f) => path.join(SITE, f)),
      path.join(SITE, "js", "site.js"),
      path.join(SITE, "js", "auth-nav.js"),
      path.join(WEB_ROOT, "public", "sw.js"),
      path.join(WEB_ROOT, "app", "sitemap.ts"),
    ];
    expect(files.filter((f) => raw.test(fs.readFileSync(f, "utf8")))).toEqual([]);
  });
});
