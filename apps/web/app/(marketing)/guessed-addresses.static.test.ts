/**
 * @jest-environment node
 */
// W6 / C7 — addresses a visitor might guess land on a real page. Same pattern as the /distributors
// alias (distributors-redirect.static.test.ts): a next.config redirect, which Next evaluates before
// middleware, so each carries a Location header. None of these may come back as a page of its own.
// `/#faq` lands on the FAQ section (it carries `id="faq"`, pinned in faq.test.tsx).
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");

function loadRedirects(): Array<{ source: string; destination: string; permanent: boolean }> {
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
  );
}

const GUESSED: Array<[string, string]> = [
  ["/about", "/company"],
  ["/demo", "/book-a-demo"],
  ["/features", "/product"],
  ["/faq", "/#faq"],
  ["/integrations", "/#faq"],
  ["/quickbooks", "/#faq"],
];

describe("guessed addresses redirect from next.config (W6 C7)", () => {
  const redirects = loadRedirects();

  it.each(GUESSED)("%s goes to %s, temporarily (307)", (source, destination) => {
    expect(redirects.find((r) => r.source === source)).toEqual({
      source,
      destination,
      permanent: false,
    });
  });

  it.each(GUESSED.map(([source]) => source))("%s is not a page of its own", (source) => {
    for (const root of ["(marketing)", ""]) {
      const dir = path.join(WEB_ROOT, "app", root, source.slice(1));
      expect(fs.existsSync(path.join(dir, "page.tsx"))).toBe(false);
    }
  });

  it("every destination page exists", () => {
    for (const [, destination] of GUESSED) {
      const route = destination.replace(/#.*$/, "");
      const file = route === "/" ? "page.tsx" : path.join(route.slice(1), "page.tsx");
      expect(fs.existsSync(path.join(WEB_ROOT, "app", "(marketing)", file))).toBe(true);
    }
  });
});
