/**
 * @jest-environment node
 */
// Visit counts on the ready-made pages (public/site). The same rule as the React pages: the tag is
// there only when the build has a site ID, on the four counted pages, never anywhere else. These
// read the HTML the route serves, and run public/site/analytics.js against a fake tracker.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { GET, generateStaticParams } from "@/app/site-page/[page]/route";
import {
  STATIC_SITE_PAGES,
  STATIC_SITE_PAGE_NAMES,
  visitCountTags,
  withVisitCount,
  type StaticSitePage,
} from "./static-site-page";
import { UMAMI_SCRIPT_SRC, umamiAllowedPath } from "./umami-tag";
import { readServedSitePage } from "./read-site-page";
import { renderSitePage, brandTokensTag } from "./static-site-page";
import { BRAND, loadBrand, loadPalette, validatePalette } from "@routeflow/types/brand";

// The brand's own host, from the seam: a name or host swap needs no edit here.
const HOST = new URL(BRAND.origin).hostname;
const APEX = HOST.replace(/^www\./, "");
const SITE_ROOT = path.resolve(__dirname, "../public/site");
const FAKE_ID = "00000000-0000-4000-8000-000000000000";
// The page as the route serves it before the visit-count tags: file, brand tokens filled.
const file = (page: string) => readServedSitePage(page as StaticSitePage, { websiteId: undefined });
const PAGES = Object.entries(STATIC_SITE_PAGES) as Array<[StaticSitePage, string]>;

const ID_VAR = "NEXT_PUBLIC_UMAMI_WEBSITE_ID";
const saved = process.env[ID_VAR];
afterEach(() => {
  if (saved === undefined) delete process.env[ID_VAR];
  else process.env[ID_VAR] = saved;
});

async function served(page: string) {
  const response = await GET(new Request(`http://localhost/site-page/${page}`), {
    params: Promise.resolve({ page }),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    html: await response.text(),
  };
}

describe("which pages", () => {
  it("V1: the route builds exactly the four files in public/site, and each address is a counted path", () => {
    const onDisk = fs
      .readdirSync(SITE_ROOT)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();
    expect([...STATIC_SITE_PAGE_NAMES].sort()).toEqual(onDisk);
    expect(
      generateStaticParams()
        .map((p) => p.page)
        .sort(),
    ).toEqual(onDisk);
    for (const [, route] of PAGES) expect(umamiAllowedPath(route)).toBe(true);
  });
});

describe.each(PAGES)("%s (%s) served with a site ID", (page, route) => {
  beforeEach(() => {
    process.env[ID_VAR] = FAKE_ID;
  });

  it("V2: the served HTML has Umami's script once, with the same attributes as the React pages", async () => {
    const { status, type, html } = await served(page);
    expect(status).toBe(200);
    expect(type).toContain("text/html");
    const tags = html.match(/<script [^>]*data-website-id="[^"]*"[^>]*><\/script>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain(`src="${UMAMI_SCRIPT_SRC}"`);
    expect(tags[0]).toContain("defer");
    expect(tags[0]).toContain(`data-website-id="${FAKE_ID}"`);
    expect(tags[0]).toContain(`data-domains="${HOST}"`);
    expect(tags[0]).toContain('data-auto-track="false"');
    expect(tags[0]).toContain('data-exclude-search="true"');
  });

  it("V3: the pageview script follows it, names this page's own path, and both sit inside <body>", async () => {
    const { html } = await served(page);
    const umami = html.indexOf(UMAMI_SCRIPT_SRC);
    const mine = html.indexOf('src="/site/analytics.js"');
    expect(umami).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(umami);
    expect(html.slice(mine, html.indexOf("</script>", mine))).toContain(`data-path="${route}"`);
    expect(html.lastIndexOf("</body>")).toBeGreaterThan(mine);
    expect(html.indexOf("<body")).toBeLessThan(umami);
  });

  it("V4: nothing else in the page changes", async () => {
    const { html } = await served(page);
    expect(html.replace(visitCountTags(page, FAKE_ID), "")).toBe(file(page));
  });
});

describe.each(PAGES)("%s (%s) served without a site ID", (page) => {
  it.each([undefined, "", "   "])(
    "V5: %j gives the file itself, no Umami and no pageview script",
    async (id) => {
      if (id === undefined) delete process.env[ID_VAR];
      else process.env[ID_VAR] = id;
      const { html } = await served(page);
      expect(html).toBe(file(page));
      expect(html).not.toContain("umami");
      expect(html).not.toContain("analytics.js");
    },
  );
});

describe("the route", () => {
  it("V6: an unknown page is a 404, not a file read", async () => {
    process.env[ID_VAR] = FAKE_ID;
    expect((await served("../../package")).status).toBe(404);
    expect((await served("sign-in")).status).toBe(404);
  });

  it("V7: a page with no </body> is refused, not served without its tag", () => {
    expect(() => withVisitCount("<html></html>", "home", FAKE_ID)).toThrow(/no <\/body>/);
    expect(withVisitCount("<html></html>", "home", undefined)).toBe("<html></html>");
  });
});

describe("public/site/analytics.js", () => {
  interface Sent {
    website?: string;
    hostname?: string;
    screen?: string;
    url?: string;
    referrer?: string;
  }
  const source = fs.readFileSync(path.join(SITE_ROOT, "analytics.js"), "utf8");

  function run(opts: { referrer?: string; track?: unknown; late?: boolean; dataPath?: string }) {
    const sent: Sent[] = [];
    const listeners: Array<() => void> = [];
    const tracker = {
      website: FAKE_ID,
      hostname: HOST,
      screen: "390x844",
      referrer: opts.referrer ?? "",
      title: "must not be sent",
      language: "must not be sent",
    };
    const track =
      "track" in opts
        ? opts.track
        : (build: (t: typeof tracker) => Sent) => void sent.push(build(tracker));
    const attrs: Record<string, string> = {
      "data-path": opts.dataPath ?? "/pricing",
      "data-own-domain": APEX,
    };
    const window: { umami?: unknown } = opts.late ? {} : { umami: { track } };
    const context = {
      window,
      location: { origin: BRAND.origin },
      URL,
      document: {
        currentScript: { getAttribute: (k: string) => attrs[k] ?? null },
        querySelector: () => ({
          addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        }),
      },
    };
    vm.runInNewContext(source, context);
    return { sent, window, listeners, track };
  }

  it("A1: sends one pageview with the five fields and nothing else", () => {
    const { sent } = run({ referrer: "https://www.google.com/search?q=x" });
    expect(sent).toEqual([
      {
        website: FAKE_ID,
        hostname: HOST,
        screen: "390x844",
        url: "/pricing",
        referrer: "https://www.google.com",
      },
    ]);
    expect(Object.keys(sent[0]).sort()).toEqual([
      "hostname",
      "referrer",
      "screen",
      "url",
      "website",
    ]);
  });

  it.each([
    ["", ""],
    [`${BRAND.origin}/login?email=a@b.c`, ""],
    [`https://acme.${APEX}/dashboard`, ""],
    [`https://${APEX}.evil.example/x`, `https://${APEX}.evil.example`],
    ["android-app://com.example", ""],
    ["not a url at all", ""],
  ])("A2: referrer %j is sent as %j", (referrer, expected) => {
    expect(run({ referrer }).sent[0].referrer).toBe(expected);
  });

  it("A3: a tracker that throws, or has no track, leaves the page alone", () => {
    expect(() =>
      run({
        track: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    expect(() => run({ track: undefined })).not.toThrow();
  });

  it("A4: if the tracker has not loaded yet it waits for it, and sends once", () => {
    const { sent, window, listeners, track } = run({ late: true });
    expect(sent).toEqual([]);
    expect(listeners).toHaveLength(1);
    window.umami = { track };
    listeners[0]();
    listeners[0]();
    expect(sent).toHaveLength(1);
  });
});

describe("renderSitePage", () => {
  const brand = loadBrand();

  it("B1: fills plain and dotted tokens, as many times as they appear", () => {
    const html = '<a>{{brand:name}}</a><img src="{{brand:logo.onLight}}"><b>{{brand:name}}</b>';
    expect(renderSitePage(html, brand)).toBe(
      `<a>${brand.name}</a><img src="${brand.logo.onLight}"><b>${brand.name}</b>`,
    );
  });

  it("B2: throws on a key the brand does not have, naming it", () => {
    expect(() => renderSitePage("{{brand:nope}}", brand)).toThrow('unknown brand key "nope"');
    expect(() => renderSitePage("{{brand:logo}}", brand)).toThrow('unknown brand key "logo"');
  });

  it("B3: throws on a leftover or malformed token", () => {
    expect(() => renderSitePage("x {{brand:name", brand)).toThrow(/leftover brand token/);
    expect(() => renderSitePage("{{brand:{{brand:name}}}}", brand)).toThrow(/leftover|unknown/);
  });

  it("B3b: a token with the wrong case is a leftover, not served", () => {
    expect(() => renderSitePage("{{Brand:name}}", brand)).toThrow(/leftover brand token/);
    expect(() => renderSitePage("{{BRAND:name}}", brand)).toThrow(/leftover brand token/);
  });

  it("B3c: whitespace inside the braces is a leftover too", () => {
    expect(() => renderSitePage("{{ brand:name}}", brand)).toThrow(/leftover brand token/);
    expect(() => renderSitePage("{{brand :name}}", brand)).toThrow(/leftover brand token/);
  });

  it("B4: a page with no token is returned untouched, and a value is escaped, not injected", () => {
    expect(renderSitePage("<p>no tokens</p>", brand)).toBe("<p>no tokens</p>");
    const evil = { ...brand, name: 'A"<b>&' };
    expect(renderSitePage("{{brand:name}}", evil)).toBe("A&quot;&lt;b&gt;&amp;");
  });

  it("B5: every served page has no token left, with the real brand", () => {
    for (const page of STATIC_SITE_PAGE_NAMES) {
      expect(readServedSitePage(page, { websiteId: undefined })).not.toContain("{{brand:");
    }
  });
});

describe("the brand-tokens style", () => {
  const palette = validatePalette({ color: { ink: "#010203", "copper-light": "#a0b0c0" } });
  const FIXTURE_STYLE =
    '<style id="brand-tokens">:root{--brand-ink:#010203;--brand-copper-light:#a0b0c0;}</style>';

  it("brandTokensTag is one style element with the palette as --brand-<key> custom properties", () => {
    expect(brandTokensTag(palette)).toBe(FIXTURE_STYLE);
  });

  it("renderSitePage puts it once at the end of <head>, and nowhere when there is no <head>", () => {
    const html = "<html><head><title>x</title></head><body>{{brand:name}}</body></html>";
    const out = renderSitePage(html, loadBrand(), palette);
    expect(out).toBe(
      `<html><head><title>x</title>${FIXTURE_STYLE}</head><body>${BRAND.name}</body></html>`,
    );
    expect(renderSitePage("<p>no head</p>", loadBrand(), palette)).toBe("<p>no head</p>");
  });

  it("does not add a second one to a page that already has it", () => {
    const once = renderSitePage("<head></head>", loadBrand(), palette);
    expect(renderSitePage(once, loadBrand(), palette)).toBe(once);
  });

  it("still throws on a leftover token in a page with a head", () => {
    expect(() => renderSitePage("<head></head>{{brand:nope}}", loadBrand(), palette)).toThrow(
      'unknown brand key "nope"',
    );
  });

  it("every served page carries the real palette once, and the page is otherwise unchanged", () => {
    for (const page of STATIC_SITE_PAGE_NAMES) {
      const html = file(page);
      expect(html.match(/<style id="brand-tokens">/g)).toHaveLength(1);
      expect(html).toContain(brandTokensTag(loadPalette()));
    }
  });
});

describe("renderSitePage without a palette", () => {
  it("null leaves the page with the brand filled and no style added", () => {
    const html = "<head></head>{{brand:name}}";
    expect(renderSitePage(html, loadBrand(), null)).toBe(`<head></head>${BRAND.name}`);
  });
});

describe("renderSitePage escaping", () => {
  it("escapes & < > \" and ' in a value", () => {
    const evil = { ...loadBrand(), name: `a&b<c>"d"'e'` } as ReturnType<typeof loadBrand>;
    expect(renderSitePage("{{brand:name}}", evil, null)).toBe(
      "a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;",
    );
  });
});
