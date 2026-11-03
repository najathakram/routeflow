/**
 * @jest-environment node
 */
// Owner order 2026-11-03: www.routeflow.info always shows home. A signed-in visitor sees "Open dashboard"
// where "Sign in" was, in the header, the phone menu and the footer of every new page. The script reads the
// presence cookies the app already sets (lib/presence-cookies.ts); there is no redirect.
import * as fs from "fs";
import * as path from "path";
import {
  BUYER_PRESENCE_COOKIE,
  LAST_PORTAL_COOKIE,
  OP_PRESENCE_COOKIE,
} from "@/lib/presence-cookies";
import { resolveLandingTarget } from "@/lib/portal-routing";

const SITE = path.resolve(__dirname, "../../public/site");
const PAGES = [
  "home.html",
  "product.html",
  "pricing.html",
  "getting-started.html",
  "does-and-doesnt.html",
  "data-in-and-out.html",
  "security.html",
  "company.html",
  "contact.html",
];

const nav = require(path.join(SITE, "js/auth-nav.js")) as {
  target: (cookie: string) => string | null;
  COOKIES: { op: string; buyer: string; last: string };
};

describe("auth-nav target", () => {
  it("reads the same cookie names the app writes", () => {
    expect(nav.COOKIES).toEqual({
      op: OP_PRESENCE_COOKIE,
      buyer: BUYER_PRESENCE_COOKIE,
      last: LAST_PORTAL_COOKIE,
    });
  });

  it.each([
    ["", null],
    ["a=1; b=2", null],
    [`${OP_PRESENCE_COOKIE}=1`, "/dashboard"],
    [`${BUYER_PRESENCE_COOKIE}=1`, "/buyer/portal"],
    [`x=1; ${OP_PRESENCE_COOKIE}=1; ${BUYER_PRESENCE_COOKIE}=1`, "/dashboard"],
    [
      `${OP_PRESENCE_COOKIE}=1; ${BUYER_PRESENCE_COOKIE}=1; ${LAST_PORTAL_COOKIE}=buyer`,
      "/buyer/portal",
    ],
    [`${OP_PRESENCE_COOKIE}=1; ${LAST_PORTAL_COOKIE}=buyer`, "/dashboard"],
    [`${BUYER_PRESENCE_COOKIE}=1; ${LAST_PORTAL_COOKIE}=op`, "/buyer/portal"],
    [`${OP_PRESENCE_COOKIE}=0`, null],
    [`not-${OP_PRESENCE_COOKIE}=1`, null],
  ])("cookie %p -> %p", (cookie, expected) => {
    expect(nav.target(cookie)).toBe(expected);
  });

  it("decides exactly as the server rule the redirect used", () => {
    for (const op of [false, true])
      for (const buyer of [false, true])
        for (const last of [undefined, "op", "buyer", "junk"]) {
          const cookie = [
            op ? `${OP_PRESENCE_COOKIE}=1` : "",
            buyer ? `${BUYER_PRESENCE_COOKIE}=1` : "",
            last ? `${LAST_PORTAL_COOKIE}=${last}` : "",
          ]
            .filter(Boolean)
            .join("; ");
          expect(nav.target(cookie)).toBe(
            resolveLandingTarget({ opAuthed: op, buyerAuthed: buyer, lastPortal: last }),
          );
        }
  });
});

describe("every page carries the swap", () => {
  it.each(PAGES)(
    "%s: header, phone menu and footer Sign in are marked, and the script loads",
    (file) => {
      const html = fs.readFileSync(path.join(SITE, file), "utf8");
      const marked = html.match(/<a[^>]*data-signin[^>]*>Sign in<\/a>/g) ?? [];
      expect(marked).toHaveLength(3);
      expect(html.match(/<a[^>]*href="\/login"[^>]*>Sign in<\/a>/g) ?? []).toHaveLength(3);
      expect(html).toContain('<script src="/site/js/auth-nav.js"></script>');
      // the store sign-in is a different door and stays
      expect(html).toContain('href="/buyer/login">Store sign in</a>');
    },
  );
});
