// W3 / M2-M4 — visitor counts with Umami. The script is wanted on the public marketing pages and
// /signup only, and only when a site ID was baked in at build time. Every test ID below is a made-up
// string; no real ID belongs in a test, a fixture or git.
import * as React from "react";
import { act, render } from "@testing-library/react";
import {
  UMAMI_SCRIPT_SRC,
  UmamiScript,
  resetUmamiPageviews,
  umamiAllowedPath,
  umamiScriptProps,
} from "./UmamiScript";

let mockPathname: string | null = "/";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
jest.mock("next/script", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { strategy: _strategy, onReady, ...rest } = props;
    // Next runs onReady once the script has loaded, and again on a later mount.
    React.useEffect(() => {
      if (typeof onReady === "function") onReady();
    }, [onReady]);
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

/**
 * Verdict on #4062 (review-c, 2026-11-01): the tracker wraps history.pushState and sends every new URL, query
 * string included, unless told not to. Next's router moves through pushState, so /signup -> /signup/check-email?email=...
 * would have sent the person's email address. The tracker below is a stand-in that models only that one behaviour as
 * the live script (cloud.umami.is/script.js) has it: it wraps history and sends location.href after every move unless
 * data-auto-track is "false", and it exposes window.umami.track(build) for a view sent by hand.
 */
describe("the tracker never watches navigation itself", () => {
  const OLD = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  let sent: { url: string; referrer?: string }[];
  let restoreHistory: () => void;

  function installLikeUmami(attrs: { get: (name: string) => string | null }) {
    const { pushState, replaceState } = window.history;
    const excludeSearch = attrs.get("data-exclude-search") === "true";
    const base = (): { url: string; referrer?: string } => ({
      url: excludeSearch
        ? window.location.pathname
        : window.location.pathname + window.location.search,
    });
    if (attrs.get("data-auto-track") !== "false") {
      const wrap = (fn: History["pushState"]): History["pushState"] =>
        function (this: History, ...a) {
          const out = fn.apply(this, a);
          sent.push(base());
          return out;
        };
      window.history.pushState = wrap(pushState);
      window.history.replaceState = wrap(replaceState);
    }
    (window as unknown as { umami: unknown }).umami = {
      track: (build: (p: Record<string, unknown>) => { url: string; referrer?: string }) =>
        sent.push(build({ ...base(), referrer: "https://search.example/?q=acme" })),
    };
    restoreHistory = () => {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      delete (window as unknown as { umami?: unknown }).umami;
    };
  }

  beforeEach(() => {
    sent = [];
    resetUmamiPageviews();
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = FAKE_ID;
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    restoreHistory?.();
    if (OLD === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = OLD;
  });

  function mountAt(path: string) {
    window.history.replaceState(null, "", path);
    mockPathname = path.split("?")[0] as string;
    // The tracker is loaded by the time the script's onReady runs, and reads the attributes the component gives it.
    const attrs = umamiScriptProps(FAKE_ID, mockPathname) as Record<string, unknown>;
    installLikeUmami({ get: (n) => (typeof attrs[n] === "string" ? (attrs[n] as string) : null) });
    return render(<UmamiScript />);
  }
  /** What Next's router does on a client move: pushState, then a render with the new pathname. */
  function navigate(view: ReturnType<typeof render>, to: string) {
    act(() => {
      window.history.pushState(null, "", to);
      mockPathname = to.split("?")[0] as string;
      view.rerender(<UmamiScript />);
    });
  }

  it("sets data-auto-track=false and data-exclude-search=true on the script", () => {
    mockPathname = "/signup";
    const script = render(<UmamiScript />).container.querySelector("script");
    expect(script?.getAttribute("data-auto-track")).toBe("false");
    expect(script?.getAttribute("data-exclude-search")).toBe("true");
  });

  it("control: without data-auto-track=false the stand-in tracker WOULD send the email (the row can fail)", () => {
    installLikeUmami({ get: () => null });
    window.history.pushState(null, "", "/signup/check-email?email=owner%40acme.com&workspace=acme");
    expect(sent.map((v) => v.url)).toEqual([
      "/signup/check-email?email=owner%40acme.com&workspace=acme",
    ]);
  });

  it("/signup submits and moves to check-email: nothing is sent for the move, and no query string ever", () => {
    const view = mountAt("/signup?utm_source=acme-newsletter");
    expect(sent).toEqual([{ url: "/signup", referrer: "https://search.example/?q=acme" }]);
    navigate(view, "/signup/check-email?email=owner%40acme.com&workspace=acme");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/email|owner|acme.com|workspace|utm_source/);
  });

  it("a marketing page to /login, then the dashboard: nothing is sent after the counted page", () => {
    const view = mountAt("/pricing");
    expect(sent.map((v) => v.url)).toEqual(["/pricing"]);
    navigate(view, "/login");
    navigate(view, "/dashboard");
    navigate(view, "/dashboard/orders?customer=acme");
    expect(sent.map((v) => v.url)).toEqual(["/pricing"]);
  });

  it("moves between counted pages send one view each, pathname only, the previous page as referrer", () => {
    const view = mountAt("/pricing");
    navigate(view, "/company");
    navigate(view, "/contact?topic=acme");
    expect(sent).toEqual([
      { url: "/pricing", referrer: "https://search.example/?q=acme" },
      { url: "/company", referrer: "/pricing" },
      { url: "/contact", referrer: "/company" },
    ]);
  });

  it("the same page rendering again sends no second view; coming back after a gap counts again", () => {
    const view = mountAt("/pricing");
    view.rerender(<UmamiScript />);
    expect(sent).toHaveLength(1);
    navigate(view, "/login");
    navigate(view, "/pricing");
    expect(sent.map((v) => v.url)).toEqual(["/pricing", "/pricing"]);
  });
});
