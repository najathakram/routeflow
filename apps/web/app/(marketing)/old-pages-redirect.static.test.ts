/**
 * @jest-environment node
 */
// "No old look left anywhere" (owner order): the old marketing pages are gone and each of their
// addresses goes to the closest page of the new site. They are next.config redirects, which Next
// evaluates before middleware, so every one carries a Location header (a prerendered redirect()
// page served from the ISR cache lost it; spec 36 T1, 2026-09-08). Old addresses are permanent
// (the search engines move across); the guessed ones stay temporary. None may come back as a page.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");

function loadConfig<T>(call: "redirects" | "rewrites"): T {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.${call}()));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    }),
  ) as T;
}

// The unconditional rules only. The host-matched rules (the old host's public pages, the main and
// alias hosts' app paths, all 307) are pinned by app-host-redirects.static.test.ts (SA-1253 C4).
const redirects = loadConfig<
  Array<{ source: string; destination: string; permanent: boolean; has?: unknown }>
>("redirects").filter((r) => !r.has);
const rewrites = loadConfig<{ beforeFiles: Array<{ source: string; destination: string }> }>(
  "rewrites",
);

// old address -> new address, permanent
const OLD: Array<[string, string]> = [
  ["/wholesalers", "/product"],
  ["/distributors", "/product"],
  ["/retailers", "/#stores"],
  ["/buyer", "/#stores"],
  ["/book-a-demo", "/contact"],
  ["/demo", "/contact"],
  ["/sign-in", "/login"],
  ["/about", "/company"],
];

// addresses a visitor might guess, temporary
const GUESSED: Array<[string, string]> = [
  ["/features", "/product"],
  ["/faq", "/#faq"],
  ["/integrations", "/#faq"],
  ["/quickbooks", "/#faq"],
];

describe("old marketing addresses redirect from next.config", () => {
  it.each(OLD)("%s goes to %s, permanently", (source, destination) => {
    expect(redirects.find((r) => r.source === source)).toEqual({
      source,
      destination,
      permanent: true,
    });
  });

  it.each(GUESSED)("%s goes to %s, temporarily", (source, destination) => {
    expect(redirects.find((r) => r.source === source)).toEqual({
      source,
      destination,
      permanent: false,
    });
  });

  it.each([...OLD, ...GUESSED].map(([source]) => source))(
    "%s is not a page of its own",
    (source) => {
      for (const root of ["(marketing)", ""]) {
        const dir = path.join(WEB_ROOT, "app", root, source.slice(1));
        expect(fs.existsSync(path.join(dir, "page.tsx"))).toBe(false);
      }
    },
  );

  it("no redirect leads to another redirect", () => {
    const sources = new Set(redirects.map((r) => r.source));
    for (const r of redirects) expect(sources.has(r.destination.replace(/#.*$/, ""))).toBe(false);
  });

  it("every destination is a page: a route in app, a ready-made file the rewrites serve, or a hash on one", () => {
    const served = new Map(rewrites.beforeFiles.map((r) => [r.source, r.destination]));
    for (const [, destination] of [...OLD, ...GUESSED]) {
      const route = destination.replace(/#.*$/, "") || "/";
      const name = served.get(route)?.replace("/site-page/", "");
      const asHtml =
        name !== undefined && fs.existsSync(path.join(WEB_ROOT, "public", "site", name + ".html"));
      const asRoute =
        fs.existsSync(path.join(WEB_ROOT, "app", route.slice(1), "page.tsx")) ||
        fs.existsSync(path.join(WEB_ROOT, "app", "(auth)", route.slice(1), "page.tsx"));
      expect(asHtml || asRoute).toBe(true);
    }
  });

  it("the hash destinations exist on the home page", () => {
    const home = fs.readFileSync(path.join(WEB_ROOT, "public", "site", "home.html"), "utf8");
    for (const hash of ["stores", "faq"]) expect(home).toContain(`id="${hash}"`);
  });
});
