// W3 / M2-M4 — visitor counts with Umami. The script is wanted on the public marketing pages and
// /signup only, and only when a site ID was baked in at build time. Every test ID below is a made-up
// string; no real ID belongs in a test, a fixture or git.
import * as React from "react";
import { render } from "@testing-library/react";
import { UMAMI_SCRIPT_SRC, UmamiScript, umamiAllowedPath, umamiScriptProps } from "./UmamiScript";

let mockPathname: string | null = "/";
// The script's load event, as next/script would fire it.
const mockScript: { onLoad?: () => void } = {};
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
jest.mock("next/script", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { strategy: _strategy, onLoad, ...rest } = props;
    mockScript.onLoad = onLoad as (() => void) | undefined;
    return (
      <script data-testid="umami" {...(rest as React.ScriptHTMLAttributes<HTMLScriptElement>)} />
    );
  },
}));

const FAKE_ID = "00000000-test-test-test-000000000000";
const MARKETING = [
  "/",
  "/product",
  "/wholesalers",
  "/retailers",
  "/pricing",
  "/company",
  "/contact",
  "/privacy",
  "/terms",
  "/book-a-demo",
];
// Everything a signed-in or signing-in person sees, plus the marketing "choose an account" page.
const NEVER = [
  "/sign-in",
  "/login",
  "/admin-login",
  "/forgot-password",
  "/reset-password",
  "/signup/check-email",
  "/dashboard",
  "/dashboard/orders",
  "/orders/123",
  "/settings/billing",
  "/buyer/portal",
  "/buyer/login",
  "/admin/dashboard",
  "/platform/auth/callback",
  "/choose-role",
  "/verify-email",
  "/handoff",
  "/not-a-page",
  "",
];

describe("umamiAllowedPath", () => {
  it.each([...MARKETING, "/signup"])("%s may carry the script", (path) => {
    expect(umamiAllowedPath(path)).toBe(true);
  });

  it.each(NEVER)("%j never carries the script", (path) => {
    expect(umamiAllowedPath(path)).toBe(false);
  });

  it("a missing pathname never carries it", () => {
    expect(umamiAllowedPath(null)).toBe(false);
  });
});

describe("umamiScriptProps", () => {
  it("is the cloud script, deferred, with the site ID and only the live site's hostname", () => {
    expect(umamiScriptProps(FAKE_ID, "/pricing")).toEqual({
      src: UMAMI_SCRIPT_SRC,
      defer: true,
      "data-website-id": FAKE_ID,
      "data-domains": "www.routeflow.info",
      "data-auto-track": "false",
      "data-exclude-search": "true",
    });
    expect(UMAMI_SCRIPT_SRC).toBe("https://cloud.umami.is/script.js");
  });

  it.each([undefined, "", "   "])("M4: no site ID (%j) means no script", (id) => {
    expect(umamiScriptProps(id, "/")).toBeNull();
  });

  it("is null on a page that never counts, even with an ID", () => {
    expect(umamiScriptProps(FAKE_ID, "/dashboard")).toBeNull();
    expect(umamiScriptProps(FAKE_ID, "/sign-in")).toBeNull();
  });
});

describe("<UmamiScript />", () => {
  const OLD = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  afterEach(() => {
    if (OLD === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = OLD;
  });

  it("renders one script on a marketing page when an ID is set", () => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = FAKE_ID;
    mockPathname = "/pricing";
    const { container } = render(<UmamiScript />);
    const scripts = container.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("data-website-id")).toBe(FAKE_ID);
    expect(scripts[0]?.getAttribute("src")).toBe(UMAMI_SCRIPT_SRC);
  });

  it("renders one on /signup", () => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = FAKE_ID;
    mockPathname = "/signup";
    expect(render(<UmamiScript />).container.querySelectorAll("script")).toHaveLength(1);
  });

  it("M4: renders nothing anywhere when no ID is set", () => {
    delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    for (const path of [...MARKETING, "/signup", ...NEVER]) {
      mockPathname = path;
      expect(render(<UmamiScript />).container.querySelectorAll("script")).toHaveLength(0);
    }
  });

  it("renders nothing on the dashboard, the retailer portal or a sign-in page, with an ID set", () => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = FAKE_ID;
    for (const path of NEVER) {
      mockPathname = path;
      expect(render(<UmamiScript />).container.querySelectorAll("script")).toHaveLength(0);
    }
  });
});

// The tracker wraps history.pushState when auto-track is on, and Next's router moves through
// pushState, so a guard at mount is not enough. This stand-in hands `track` the same payload the
// real tracker builds: the URL it loaded on, and the referrer it read then.
describe("<UmamiScript /> pageviews", () => {
  const OLD = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  type Payload = { url?: string; referrer?: string };
  let sent: Payload[];

  function installTracker(referrer = "") {
    sent = [];
    window.umami = {
      track: (build) =>
        sent.push(
          build({
            website: FAKE_ID,
            hostname: "www.routeflow.info",
            screen: "1440x900",
            language: "en-US",
            title: "A page",
            url: "https://www.routeflow.info/signup?email=owner%40acme.com",
            referrer,
          } as Parameters<typeof build>[0]),
        ),
    };
  }

  const urls = () => sent.map((p) => p.url);
  const at = (path: string) => {
    mockPathname = path;
    return <UmamiScript />;
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = FAKE_ID;
    mockScript.onLoad = undefined;
    sent = [];
    delete window.umami;
  });

  afterEach(() => {
    delete window.umami;
    if (OLD === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = OLD;
  });

  it("sends one pageview for the page it mounts on, as the bare pathname", () => {
    installTracker();
    render(at("/pricing"));
    expect(urls()).toEqual(["/pricing"]);
  });

  it("holds the first pageview until the script has loaded, then sends it once", () => {
    render(at("/pricing"));
    expect(sent).toEqual([]);
    installTracker();
    mockScript.onLoad?.();
    mockScript.onLoad?.();
    expect(urls()).toEqual(["/pricing"]);
  });

  it("keeps a page left before the script loaded, and still sends each one once", () => {
    const view = render(at("/"));
    view.rerender(at("/pricing"));
    installTracker();
    mockScript.onLoad?.();
    expect(urls()).toEqual(["/", "/pricing"]);
  });

  it("does not send twice when Strict Mode runs the effect twice", () => {
    installTracker();
    render(<React.StrictMode>{at("/pricing")}</React.StrictMode>);
    expect(urls()).toEqual(["/pricing"]);
  });

  it("a re-render on the same page sends nothing more", () => {
    installTracker();
    const view = render(at("/pricing"));
    view.rerender(at("/pricing"));
    expect(urls()).toEqual(["/pricing"]);
  });

  it("sends each allowed page on a client move, and again on a return", () => {
    installTracker();
    const view = render(at("/"));
    view.rerender(at("/pricing"));
    view.rerender(at("/"));
    expect(urls()).toEqual(["/", "/pricing", "/"]);
  });

  it.each(NEVER)("sends nothing on a client move to %j", (path) => {
    installTracker();
    const view = render(at("/pricing"));
    view.rerender(at(path));
    expect(urls()).toEqual(["/pricing"]);
  });

  it("sends nothing for a disallowed page even when the script finishes loading on it", () => {
    const view = render(at("/sign-in"));
    view.rerender(at("/login"));
    installTracker();
    mockScript.onLoad?.();
    expect(sent).toEqual([]);
  });

  it("counts an allowed page again after a stop on a disallowed one", () => {
    installTracker();
    const view = render(at("/pricing"));
    view.rerender(at("/sign-in"));
    view.rerender(at("/pricing"));
    expect(urls()).toEqual(["/pricing", "/pricing"]);
  });

  it("never lets the query string out on an allowed page", () => {
    installTracker("https://www.routeflow.info/signup/check-email?email=owner%40acme.com");
    render(at("/signup"));
    expect(urls()).toEqual(["/signup"]);
    const body = JSON.stringify(sent);
    expect(body).not.toContain("?");
    expect(body).not.toContain("owner");
  });

  it("sends only what the Privacy Policy names", () => {
    installTracker("https://news.example.com/story");
    render(at("/pricing"));
    expect(sent).toEqual([
      {
        website: FAKE_ID,
        hostname: "www.routeflow.info",
        screen: "1440x900",
        url: "/pricing",
        referrer: "https://news.example.com",
      },
    ]);
  });

  it.each([
    ["our own page, as a path", "/signup/check-email?email=owner%40acme.com", ""],
    ["our own page, in full", "https://www.routeflow.info/login", ""],
    ["our own host with no www", "https://routeflow.info/", ""],
    ["a tenant's host, which names a client", "https://acme.routeflow.info", ""],
    ["an app link", "android-app://com.google.android.gm/", ""],
    ["nonsense", "http://", ""],
    ["no referrer", "", ""],
    [
      "another site, with a path and query",
      "https://news.example.com/a?b=c",
      "https://news.example.com",
    ],
  ])("referrer: %s", (_name, referrer, expected) => {
    installTracker(referrer);
    render(at("/"));
    expect(sent[0]?.referrer).toBe(expected);
  });

  it("gives the referring site to the first pageview only", () => {
    installTracker("https://news.example.com/story");
    const view = render(at("/"));
    view.rerender(at("/pricing"));
    expect(sent.map((p) => p.referrer)).toEqual(["https://news.example.com", ""]);
  });

  it("M3: a tracker that throws, or has no track, leaves the page alone", () => {
    window.umami = {
      track: () => {
        throw new Error("blocked");
      },
    };
    expect(() => render(at("/pricing"))).not.toThrow();
    window.umami = {};
    expect(() => render(at("/product"))).not.toThrow();
  });
});
