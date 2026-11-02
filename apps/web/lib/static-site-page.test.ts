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

const SITE_ROOT = path.resolve(__dirname, "../public/site");
const FAKE_ID = "00000000-0000-4000-8000-000000000000";
const file = (page: string) => fs.readFileSync(path.join(SITE_ROOT, `${page}.html`), "utf8");
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
    expect(tags[0]).toContain('data-domains="www.routeflow.info"');
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
      hostname: "www.routeflow.info",
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
      "data-own-domain": "routeflow.info",
    };
    const window: { umami?: unknown } = opts.late ? {} : { umami: { track } };
    const context = {
      window,
      location: { origin: "https://www.routeflow.info" },
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
        hostname: "www.routeflow.info",
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
    ["https://www.routeflow.info/login?email=a@b.c", ""],
    ["https://acme.routeflow.info/dashboard", ""],
    ["https://routeflow.info.evil.example/x", "https://routeflow.info.evil.example"],
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
