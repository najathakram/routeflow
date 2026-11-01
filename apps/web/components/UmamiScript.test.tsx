// W3 / M2-M4 — visitor counts with Umami. The script is wanted on the public marketing pages and
// /signup only, and only when a site ID was baked in at build time. Every test ID below is a made-up
// string; no real ID belongs in a test, a fixture or git.
import * as React from "react";
import { render } from "@testing-library/react";
import { UMAMI_SCRIPT_SRC, UmamiScript, umamiAllowedPath, umamiScriptProps } from "./UmamiScript";

let mockPathname: string | null = "/";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
jest.mock("next/script", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { strategy: _strategy, ...rest } = props;
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
