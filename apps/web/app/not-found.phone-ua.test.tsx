/**
 * @jest-environment node
 */
// B249: a mistyped marketing address on a phone used to be proxied to the mobile app instead of
// showing the site's own 404. The proxy is gone (R-MKT T11); this pins the case the registry named:
// a path that is not one of the real pages, asked for with a phone user agent, is left alone by the
// middleware (no rewrite, no redirect), so the 404 page renders. Already fixed at HEAD, so this test
// is a regression pin and was green from the start.
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND } from "@routeflow/types/brand";
import { middleware } from "@/middleware";
import NotFound from "./not-found";

const PHONE_UAS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
];
const MISTYPED = ["/produkt", "/pricing-old", "/no/such/page"];
const WWW_HOST = BRAND.origin;

describe("B249: a mistyped address on a phone reaches the site's 404", () => {
  it.each(PHONE_UAS.flatMap((ua, i) => MISTYPED.map((p) => [p, i] as const)))(
    "%s is not rewritten or redirected (phone %i)",
    (pathname, phone) => {
      const response = middleware(
        new NextRequest(`http://localhost:3001${pathname}`, {
          headers: { "user-agent": PHONE_UAS[phone] },
        }),
      );
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
      expect(response.headers.get("location")).toBeNull();
      expect(response.status).toBe(200);
    },
  );

  it("a mistyped address on the brand's www host is left alone on a phone too", () => {
    const response = middleware(
      new NextRequest(`${WWW_HOST}/produkt`, { headers: { "user-agent": PHONE_UAS[0] } }),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
  });

  it("the 404 page says what happened and leads home", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("We can’t find that page.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to /);
  });
});
