/**
 * TP-E2E — public site (spec 36), project "marketing".
 *
 * Proves (post-deploy only, per test-plan.md "Harness notes" — NEVER run locally):
 *   T1  — the pages under the public site header and footer render (Company, Contact, Privacy,
 *         Terms), the 404 page wears the same header, and Contact is email only.
 *   T2  — the phone menu on the React pages opens, and no public page scrolls sideways.
 *   T2c — every old address redirects to its new home, and /faq lands on the home FAQ.
 *   T3  — every internal link on the public pages resolves.
 *   T12 — a mobile UA still gets the site on /pricing.
 *   T13b — visit counts (Umami) reach the counted pages and /signup only.
 *   T16 — head, share image and sitemap. T17 — heading order. T19 — the ready-made pages.
 *
 * Company, Contact, Pricing, Product, Home, Landing and the four deep pages are ready-made HTML
 * (public/site) served by rewrites in next.config.mjs. /privacy and /terms are React pages that
 * wear the same header and footer (components/site-frame). The old React pages (/wholesalers,
 * /retailers, /book-a-demo, /sign-in) are gone and redirect.
 *
 * Signed-out throughout — no storageState, dependencies: [] on the "marketing" project
 * (playwright.config.ts).
 */
import { test, expect, devices } from "@playwright/test";

// The pages that wear the site header and footer, with their one h1.
const H1_BY_ROUTE: Record<string, string> = {
  "/company": "We make wholesalers’ lives easier.",
  "/contact": "Email us.",
  "/privacy": "Privacy Policy",
  "/terms": "Terms of Service",
};

const PUBLIC_ROUTES = Object.keys(H1_BY_ROUTE);

// The home, pricing, product, landing and four deep pages are ready-made HTML (public/site), served by
// rewrites: their own header and footer. T19 covers them, and so does Company and Contact.
const READY_MADE_ROUTES = [
  "/",
  "/pricing",
  "/product",
  "/landing",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
];

// components/site-frame/site-frame-nav.ts (NAV_LINKS), the same list the ready-made pages carry.
const NAV_ITEMS = ["Product", "Use cases", "For stores", "Pricing", "Getting started", "Company"];

// ─── T1 — the pages under the site header and footer ────────────────────────

test.describe("T1 — public pages share one header and footer", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`T1 — ${route}: 200, one h1, header nav + footer chrome`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.status(), `${route} status`).toBe(200);

      const h1 = page.locator("h1");
      await expect(h1, `${route} renders exactly one h1`).toHaveCount(1);
      await expect(h1).toHaveText(H1_BY_ROUTE[route]!);

      // At 1080px and below the header nav is hidden and the same links live in the phone menu.
      const menuButton = page.locator("header.site-header .menu-btn");
      let nav = page.locator("header.site-header ul.nav-links");
      if (await menuButton.isVisible()) {
        await menuButton.click();
        nav = page.locator("#mobile-menu");
      }
      for (const item of NAV_ITEMS) {
        await expect(
          nav.getByRole("link", { name: item, exact: true }),
          `${route} header nav is missing "${item}"`,
        ).toBeVisible();
      }

      const header = page.locator("header.site-header");
      await expect(header.getByRole("link", { name: "Start free trial" }).first()).toHaveAttribute(
        "href",
        "/signup",
      );

      const footer = page.locator("footer.site-footer");
      await expect(footer.getByRole("link", { name: "Privacy Policy", exact: true })).toBeVisible();
      await expect(
        footer.getByRole("link", { name: "Terms of Service", exact: true }),
      ).toBeVisible();
      await expect(
        footer.getByRole("link", { name: "Store sign in", exact: true }),
      ).toHaveAttribute("href", "/buyer/login");
    });
  }

  test("T1 — a bogus path 404s under the site header, with a way back home", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist-e2e-36");
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("We can’t find that page.");
    await expect(page.locator("header.site-header")).toBeVisible();
    await expect(page.locator('main a[href="/"]').first()).toBeVisible();
  });

  for (const route of ["/privacy", "/terms"]) {
    test(`T1 — ${route} wears the site header and carries the legal text`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("header.site-header")).toBeVisible();
      await expect(page.locator(".rf-legal")).toBeVisible();
      await expect(page.locator(".rf-legal h1")).toHaveText(H1_BY_ROUTE[route]!);
    });
  }

  test("T1 — /privacy and /terms are indexable (they carry the real policy text)", async ({
    page,
  }) => {
    for (const route of ["/privacy", "/terms"]) {
      await page.goto(route);
      const robots = await page
        .locator('meta[name="robots"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("content") ?? "").join(","));
      expect(robots, `${route} robots meta`).not.toMatch(/noindex/i);
    }
  });

  test("T1 — /contact is email only: the address, no scheduler, no form, no phone, hours or address", async ({
    page,
  }) => {
    await page.goto("/contact");
    const main = page.locator("main");
    await expect(
      main.locator('a[href="mailto:hello@routeflow.info"]').first(),
      "the email link",
    ).toBeVisible();
    await expect(main.locator("form, input, textarea, select")).toHaveCount(0);
    await expect(page.locator('a[href="/book-a-demo"]')).toHaveCount(0);
    const text = (await main.innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/video call|calendar|scheduler|book a /i);
    expect(text).not.toMatch(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);
    expect(text).not.toMatch(/\b(hours|monday|street|suite)\b/i);
  });

  test("T1 — /company has the founder note and no picture or photo credit", async ({ page }) => {
    await page.goto("/company");
    await expect(page.locator("main img")).toHaveCount(0);
    await expect(page.locator('a[href*="pexels"]')).toHaveCount(0);
    await expect(page.locator("main")).toContainText("Dr. Najath Akram");
  });
});

// ─── T2 — phone menu + no sideways scroll ────────────────────────────────────

// `devices["iPhone 13"]` carries `defaultBrowserType`, which Playwright
// refuses inside a describe-scoped `test.use()` (it would force a new
// worker) — spread everything else (viewport, userAgent, isMobile, hasTouch).
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
const { defaultBrowserType: _desktopBrowserType, ...desktopChrome } = devices["Desktop Chrome"];

test.describe("T2 — the phone menu on the React pages", () => {
  test.use({ ...desktopChrome, viewport: { width: 375, height: 812 } });

  test("T2 — /privacy: the menu button opens the phone menu, Escape closes it", async ({
    page,
  }) => {
    await page.goto("/privacy");
    await page.waitForLoadState("networkidle");

    const button = page.locator("button.menu-btn");
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");

    const menu = page.locator("#mobile-menu");
    await expect(menu).toHaveClass(/\bopen\b/);
    await expect(menu.getByRole("link", { name: "Start free trial" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
      "href",
      "/login",
    );

    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("T2 — no public page scrolls sideways at 390px", () => {
  test.use({ ...desktopChrome, viewport: { width: 390, height: 844 } });

  for (const route of PUBLIC_ROUTES) {
    test(`T2 — ${route}: the page is no wider than the screen`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("h1")).toBeVisible();
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(widths.doc, "documentElement.scrollWidth").toBeLessThanOrEqual(widths.inner);
      expect(widths.body, "body.scrollWidth").toBeLessThanOrEqual(widths.inner);
    });
  }
});

// ─── T2b — the header fits on one line from 901 to 1440 px, on the ready-made and the React pages ─────

// Above 1080 px the header shows the nav links; at 1080 and below it shows the menu button instead.
const HEADER_FIT_WIDTHS: Array<[number, boolean]> = [
  [1440, true],
  [1281, true],
  [1100, true],
  [1081, true],
  [1080, false],
  [1024, false],
  [901, false],
];

test.describe("T2b — the header is one line with no overlap and no sideways scroll", () => {
  for (const [width, navShown] of HEADER_FIT_WIDTHS) {
    for (const route of ["/", "/company"]) {
      test.describe(`at ${width}px`, () => {
        test.use({ ...desktopChrome, viewport: { width, height: 900 } });

        test(`T2b — ${route} at ${width}px: ${navShown ? "nav links" : "menu button"}, one row, no overlap`, async ({
          page,
        }) => {
          await page.goto(route);
          const header = page.locator("header.site-header");
          await expect(header).toBeVisible();
          await expect(header.locator("ul.nav-links")).toBeVisible({ visible: navShown });
          await expect(header.locator(".menu-btn")).toBeVisible({ visible: !navShown });

          const measured = await header.evaluate((el) => {
            const shown = (n: Element) => {
              const r = n.getBoundingClientRect();
              const cs = getComputedStyle(n);
              return (
                r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
              );
            };
            const rects = [
              ...el.querySelectorAll(
                ".brand, .nav-links a, .nav-signin, .nav-price, .menu-btn, .nav-actions .btn",
              ),
            ]
              .filter(shown)
              .map((n) => {
                const r = n.getBoundingClientRect();
                return {
                  text: (n.textContent ?? "").replace(/\s+/g, " ").trim(),
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  centre: (r.top + r.bottom) / 2,
                  height: r.height,
                };
              });
            const sorted = [...rects].sort((a, b) => a.left - b.left);
            const overlaps = sorted
              .slice(1)
              .map((r, i) => ({ a: sorted[i]!, b: r }))
              .filter(({ a, b }) => b.left < a.right - 0.5)
              .map(({ a, b }) => `${a.text} / ${b.text}`);
            const box = el.getBoundingClientRect();
            return {
              count: rects.length,
              overlaps,
              // one row: every item's centre is on the same line, and nothing wrapped to a second line
              centreSpread:
                Math.max(...rects.map((r) => r.centre)) - Math.min(...rects.map((r) => r.centre)),
              tallest: Math.max(...rects.map((r) => r.height)),
              inside: rects.every((r) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5),
              right: Math.max(...rects.map((r) => r.right)),
              doc: document.documentElement.scrollWidth,
              inner: window.innerWidth,
            };
          });
          expect(measured.count, "header items found").toBeGreaterThan(2);
          expect(measured.overlaps, "overlapping items").toEqual([]);
          expect(measured.centreSpread, "items on one row").toBeLessThan(8);
          expect(measured.tallest, "tallest item (a wrapped label is taller)").toBeLessThan(60);
          expect(measured.inside, "items inside the header").toBe(true);
          expect(measured.right, "rightmost item").toBeLessThanOrEqual(measured.inner);
          expect(measured.doc, "sideways scroll").toBeLessThanOrEqual(measured.inner);
        });
      });
    }
  }
});

// ─── T2c — old addresses redirect; /faq lands on the home FAQ ───────────────────────────────────

// [old address, where it goes, permanent]. Permanent ones answer 308 in Next (301 from a proxy).
const REDIRECTS: Array<[string, string, boolean]> = [
  ["/wholesalers", "/product", true],
  ["/distributors", "/product", true],
  ["/retailers", "/#stores", true],
  ["/buyer", "/#stores", true],
  ["/book-a-demo", "/contact", true],
  ["/demo", "/contact", true],
  ["/sign-in", "/login", true],
  ["/about", "/company", true],
  ["/features", "/product", false],
  ["/faq", "/#faq", false],
  ["/integrations", "/#faq", false],
  ["/quickbooks", "/#faq", false],
];

test.describe("T2c — old addresses redirect to the new site", () => {
  for (const [from, to, permanent] of REDIRECTS) {
    test(`T2c — ${from} redirects to ${to} (${permanent ? "permanent" : "temporary"})`, async ({
      request,
    }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      const expected = permanent ? [301, 308] : [302, 307];
      expect(expected, `${from} status was ${response.status()}`).toContain(response.status());
      const location = response.headers()["location"] ?? "";
      expect(location.endsWith(to), `${from} Location was "${location}"`).toBe(true);
    });
  }
});

for (const [label, device] of [
  ["desktop", desktopChrome],
  ["phone", iPhone13],
] as const) {
  test.describe(`T2c — on a ${label}: /faq lands on the home FAQ`, () => {
    test.use({ ...device });

    test("T2c — /faq lands on /#faq with the FAQ heading clear of the sticky header", async ({
      page,
    }) => {
      const response = await page.goto("/faq");
      expect(response?.status(), "/faq final status").toBe(200);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(new URL(page.url()).hash).toBe("#faq");
      const faq = page.locator("#faq");
      await expect(faq).toBeVisible();
      const heading = faq.getByRole("heading", { name: "Questions before you start." });
      await expect(heading).toBeInViewport();
      const headerBottom = await page
        .locator("header.site-header")
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const headingTop = await heading.evaluate((el) => el.getBoundingClientRect().top);
      expect(headingTop, "FAQ heading is below the sticky header").toBeGreaterThanOrEqual(
        headerBottom - 1,
      );
    });
  });
}

test.describe("T2c — the home FAQ answers the QuickBooks question straight", () => {
  test("T2c — Does it connect to my other tools? answers 'Not directly', names QuickBooks and CSV", async ({
    page,
  }) => {
    await page.goto("/#faq");
    await page.getByText("Does it connect to my other tools?").click();
    const answer = page.locator("#faq details[open] p");
    await expect(answer).toContainText("Not directly");
    await expect(answer).toContainText("QuickBooks");
    await expect(answer).toContainText("CSV");
  });
});

// ─── T3 — every internal link on the public pages resolves ──────────────────

test.describe("T3 — every internal link on the public pages resolves", () => {
  test('T3 — crawl a[href^="/"] on the public pages, expect status < 400 incl. auth routes', async ({
    page,
    request,
  }) => {
    const found = new Set<string>();
    for (const route of [...PUBLIC_ROUTES, ...READY_MADE_ROUTES]) {
      await page.goto(route);
      const hrefs = await page
        .locator('a[href^="/"]')
        .evaluateAll((anchors) =>
          anchors.map((a) => (a as HTMLAnchorElement).getAttribute("href") || ""),
        );
      for (const href of hrefs) {
        const path = href.split("#")[0] || "/";
        if (path) found.add(path);
      }
    }
    expect(found.size, "at least one internal link found across the pages").toBeGreaterThan(0);

    const results: { href: string; status: number }[] = [];
    for (const href of Array.from(found)) {
      const response = await request.get(href);
      results.push({ href, status: response.status() });
    }

    const failures = results.filter((r) => r.status >= 400);
    expect(failures, `broken internal links: ${JSON.stringify(failures)}`).toEqual([]);

    for (const authPath of ["/login", "/signup"]) {
      const hit = results.find((r) => r.href === authPath);
      expect(hit?.status, `${authPath} was not linked from any page, or did not 200`).toBe(200);
    }

    const buyerHits = results.filter((r) => r.href.startsWith("/buyer"));
    expect(buyerHits.length, "at least one /buyer/* link found across the pages").toBeGreaterThan(
      0,
    );
    for (const hit of buyerHits) {
      expect(hit.status, `${hit.href} status`).toBe(200);
    }
  });
});

// ─── T12 — mobile UA + /pricing still serves the site ───────────────────────

test.describe("T12 — a mobile UA still gets the site on /pricing", () => {
  test("T12 — /pricing under a mobile UA returns 200 with the plans heading", async ({
    request,
  }) => {
    const response = await request.get("/pricing", {
      headers: { "User-Agent": devices["iPhone 13"].userAgent },
    });
    expect(response.status()).toBe(200);

    const body = await response.text();
    expect(
      body,
      "response body should contain the /pricing opening words (proves it is NOT the mobile build)",
    ).toContain("Plans from $");
  });
});

// ─── T13b — W3: visitor counts (Umami) reach the counted pages and /signup only ─────────────────

// The script is on the page only when the stack was built with NEXT_PUBLIC_UMAMI_WEBSITE_ID. These
// rows read which case this stack is in from /privacy itself, so the same spec holds on a
// local stack (no ID: M4, no script anywhere) and on one built with a made-up test ID. No real ID
// is ever used in a test.
const UMAMI_TRACKER_URL = "https://cloud.umami.is/script.js";
const UMAMI_SCRIPT = `script[src="${UMAMI_TRACKER_URL}"]`;
const COUNTED_ROUTES = [
  "/",
  "/pricing",
  "/product",
  "/landing",
  "/company",
  "/contact",
  "/privacy",
  "/terms",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
  "/signup",
];
// Never counted: sign-in pages, the retailer portal, the dashboard (signed out, these land on a
// sign-in page, which must carry nothing either). The old redirected addresses are not counted
// either; they never render a page of their own.
const NEVER_COUNTED_ROUTES = [
  "/login",
  "/admin-login",
  "/forgot-password",
  "/buyer/login",
  "/buyer/portal",
  "/dashboard",
];

// The preload tag is in the server's HTML, so this needs no wait for hydration.
async function stackHasSiteId(page: import("@playwright/test").Page) {
  return (await (await page.request.get("/privacy")).text()).includes(UMAMI_TRACKER_URL);
}

async function umamiScriptCount(page: import("@playwright/test").Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle");
  return page.locator(UMAMI_SCRIPT).count();
}

// A stand-in for cloud.umami.is/script.js. The real tracker turns itself off on this host
// (data-domains), so this one leaves that check out and keeps the rest of what it does: it honours
// data-auto-track and data-exclude-search, wraps pushState and replaceState when auto-track is on,
// exposes umami.track with the real call shape, and posts to the real address. Read from the
// tracker as served on 2026-10-31.
const FAKE_UMAMI_TRACKER = `(() => {
  const script = document.currentScript;
  const autoTrack = script.getAttribute("data-auto-track") !== "false";
  const excludeSearch = script.getAttribute("data-exclude-search") === "true";
  const filter = (href) => {
    if (!href) return href;
    const url = new URL(href, location.href);
    if (excludeSearch) url.search = "";
    return url.toString();
  };
  let current = filter(location.href);
  let previous = filter(document.referrer);
  const payload = () => ({
    website: script.getAttribute("data-website-id"),
    screen: "1440x900",
    language: navigator.language,
    title: document.title,
    hostname: location.hostname,
    url: current,
    referrer: previous.startsWith(location.origin) ? previous.slice(location.origin.length) : previous,
  });
  const track = (build) => {
    const body = typeof build === "function" ? build(payload()) : payload();
    fetch("https://gateway.umami.is/api/send", {
      method: "POST",
      keepalive: true,
      body: JSON.stringify({ type: "event", payload: body }),
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
    }).catch(() => {});
  };
  window.umami = { track };
  if (!autoTrack) return;
  track();
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (state, title, next) {
      const result = original.apply(this, arguments);
      if (next) {
        previous = current;
        current = filter(next);
        if (current !== previous) setTimeout(track, 300);
      }
      return result;
    };
  }
})();`;

interface UmamiSend {
  url?: string;
  referrer?: string;
}

/** Serves the stand-in and catches every post, so nothing reaches Umami. */
async function catchUmamiSends(page: import("@playwright/test").Page) {
  const sent: UmamiSend[] = [];
  await page.route(UMAMI_TRACKER_URL, (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_UMAMI_TRACKER }),
  );
  await page.route("https://gateway.umami.is/api/send", (route) => {
    sent.push(route.request().postDataJSON().payload);
    return route.fulfill({ json: {}, headers: { "access-control-allow-origin": "*" } });
  });
  return sent;
}

/** The tracker reports a move 300 ms after it, so "nothing went out" needs longer than that. */
async function settled(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}

/**
 * Opens a counted page and waits for its pageview, so it has hydrated and a link click is a client
 * move. Then marks the document, so a row can prove the next move was not a full page load.
 */
async function openCounted(
  page: import("@playwright/test").Page,
  sent: UmamiSend[],
  route: string,
) {
  const before = sent.length;
  await page.goto(route);
  await expect.poll(() => sent.length).toBeGreaterThan(before);
  await settled(page);
  await page.evaluate(() => {
    (window as unknown as { sameDocument?: boolean }).sameDocument = true;
  });
}
const stillSameDocument = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument === true);

test.describe("T13b — W3 M2-M4: visitor counts", () => {
  test("T13b — sign-in pages, the retailer portal and the dashboard never load the script", async ({
    page,
  }) => {
    for (const route of NEVER_COUNTED_ROUTES) {
      expect(await umamiScriptCount(page, route), `${route} analytics scripts`).toBe(0);
    }
  });

  test("T13b — the platform admin dashboard never loads the script", async ({ page }) => {
    // A signed-in admin view with the API stubbed: the layout only parses the token's payload.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64({ role: "SUPER_ADMIN", exp: 4102444800 })}.x`;
    await page.addInitScript((t) => localStorage.setItem("superAdminToken", t), token);
    // The dashboard reads `planBreakdown` and the tenant counts on first paint, so its stats call
    // gets a full empty shape; every other call gets `{}`.
    const stats = {
      tenants: { total: 0, active: 0, trial: 0, suspended: 0 },
      totalUsers: 0,
      newTenantsThisMonth: 0,
      mrr: 0,
      ledgerMrr: 0,
      planBreakdown: {},
      recentTenants: [],
      trialsExpiringSoon: [],
      atRiskTenants: [],
    };
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/platform-admin/stats")) return route.fulfill({ json: stats });
      if (path.endsWith("/platform-admin/stats/growth")) return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    });
    await page.goto("/admin/dashboard");
    // The sidebar is hidden below 1024px (a drawer there), so only a wide screen shows a navigation.
    if ((page.viewportSize()?.width ?? 1280) >= 1024) {
      await expect(page.getByRole("navigation").first()).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Platform Dashboard" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(UMAMI_SCRIPT)).toHaveCount(0);
  });

  test("T13b — M4: a stack built with no site ID sends no script on any page", async ({ page }) => {
    test.skip(await stackHasSiteId(page), "this stack was built with a site ID");
    for (const route of [...COUNTED_ROUTES, ...NEVER_COUNTED_ROUTES]) {
      expect(await umamiScriptCount(page, route), `${route} analytics scripts`).toBe(0);
    }
  });

  test("T13b — with a site ID, every counted page and /signup carries one deferred script for the live host", async ({
    page,
  }) => {
    test.skip(!(await stackHasSiteId(page)), "this stack has no site ID (M4)");
    for (const route of COUNTED_ROUTES) {
      expect(await umamiScriptCount(page, route), `${route} analytics scripts`).toBe(1);
      const script = page.locator(UMAMI_SCRIPT);
      expect(await script.getAttribute("data-website-id"), `${route} site id`).toBeTruthy();
      expect(await script.getAttribute("data-domains"), `${route} domains`).toBe(
        "www.routeflow.info",
      );
      expect(await script.evaluate((el) => (el as HTMLScriptElement).defer), `${route} defer`).toBe(
        true,
      );
    }
  });

  test("T13b — M3: with the script blocked, pages still work and the page raises no error", async ({
    page,
  }) => {
    test.skip(!(await stackHasSiteId(page)), "this stack has no site ID (M4)");
    await page.route("https://cloud.umami.is/**", (route) => route.abort());
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      // Chrome itself logs "Failed to load resource" for any blocked request (an ad blocker does the
      // same); that is the browser, not the page. Anything else is the page's own error.
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
        consoleErrors.push(m.text());
      }
    });
    for (const route of ["/privacy", "/company", "/signup"]) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} status`).toBe(200);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1, h2").first(), `${route} still renders`).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("T13b — client moves from a counted page to a sign-in page report nothing past the counted pages", async ({
    page,
  }) => {
    test.skip(!(await stackHasSiteId(page)), "this stack has no site ID (M4)");
    const sent = await catchUmamiSends(page);

    await openCounted(page, sent, "/privacy");
    await page
      .locator("footer.site-footer")
      .getByRole("link", { name: "Terms of Service", exact: true })
      .click();
    await page.waitForURL("**/terms");
    await settled(page);

    // This is the router call a client move to /login comes down to (the one /login itself makes
    // into the dashboard).
    await page.evaluate(() =>
      (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(
        "/login",
      ),
    );
    await page.waitForURL("**/login");
    await settled(page);
    expect(await stillSameDocument(page), "the move to /login was a client one").toBe(true);

    await openCounted(page, sent, "/privacy");
    await page
      .locator("footer.site-footer")
      .getByRole("link", { name: "Store sign in", exact: true })
      .click();
    await page.waitForURL("**/buyer/login**");
    await settled(page);
    expect(await stillSameDocument(page), "the move to /buyer/login was a client one").toBe(true);

    expect(sent.map((s) => s.url)).toEqual(["/privacy", "/terms", "/privacy"]);
  });

  test("T13b — submitting /signup sends nothing about the person to Umami", async ({ page }) => {
    test.skip(!(await stackHasSiteId(page)), "this stack has no site ID (M4)");
    const sent = await catchUmamiSends(page);
    const apiHeaders = { "access-control-allow-origin": "*" };
    await page.route("**/public/tenants/*-available**", (route) =>
      route.fulfill({ json: { available: true }, headers: apiHeaders }),
    );
    await page.route("**/public/tenants/register", (route) =>
      route.fulfill({ json: { emailSent: true }, headers: apiHeaders }),
    );

    await openCounted(page, sent, "/signup");
    await page.getByLabel("Business name").fill("Acme Distribution Co.");
    await page.getByLabel("Email").fill("owner@acme.com");
    await page.locator("#signup-password").fill("Sample-pass1");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("**/signup/check-email?email=**");
    await settled(page);
    expect(await stillSameDocument(page), "the move to check-email was a client one").toBe(true);

    // "Sign up again" is a full page load, so the browser's referrer is the check-email address,
    // query string and all. It stops at the browser.
    await page.locator('a[href="/signup"]').click();
    await page.waitForURL("**/signup");
    await settled(page);

    expect(sent.map((s) => s.url)).toEqual(["/signup", "/signup"]);
    expect(sent.map((s) => s.referrer)).toEqual(["", ""]);
    expect(JSON.stringify(sent)).not.toMatch(/acme|email|check-email|\?/i);
  });
});

// ─── T16 — W8: head, share image and sitemap ──────────────────────────────────

const HEAD_ROUTES = ["/company", "/contact", "/privacy", "/terms"];

// Exactly the public pages the sitemap lists. The old addresses are redirects, so none is here.
const SITEMAP_PATHS = [
  "/",
  "/product",
  "/pricing",
  "/company",
  "/contact",
  "/privacy",
  "/terms",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
];

test.describe("T16 — W8: head, share image and sitemap", () => {
  for (const route of HEAD_ROUTES) {
    test(`T16 — ${route}: title, description, canonical, share image and card are all in the head`, async ({
      page,
      request,
    }) => {
      await page.goto(route);
      const attr = (selector: string, name: string) =>
        page.locator(selector).first().getAttribute(name);

      // "Company | RouteFlow" on the ready-made pages, "Privacy Policy · RouteFlow" on the React ones.
      const title = await page.title();
      expect(title, `${route} title`).toMatch(/\S (·|\|) RouteFlow$/);

      expect(
        await attr('meta[name="description"]', "content"),
        `${route} description`,
      ).toBeTruthy();
      const canonical = await attr('link[rel="canonical"]', "href");
      expect(canonical, `${route} canonical`).toBe(`https://www.routeflow.info${route}`);
      expect(await attr('meta[property="og:title"]', "content"), `${route} og:title`).toBeTruthy();
      expect(await attr('meta[name="twitter:card"]', "content"), `${route} twitter:card`).toBe(
        "summary_large_image",
      );

      // The share image: named in the head, and it answers 200 as a PNG. The head holds the
      // production origin (metadataBase), so fetch the same path from the host under test.
      const image = await attr('meta[property="og:image"]', "content");
      expect(image, `${route} og:image`).toBeTruthy();
      expect(await attr('meta[name="twitter:image"]', "content"), `${route} twitter:image`).toBe(
        image,
      );
      const response = await request.get(new URL(image!).pathname);
      expect(response.status(), `${route} share image status`).toBe(200);
      expect(response.headers()["content-type"], `${route} share image type`).toBe("image/png");
    });
  }

  test("T16 — the sitemap lists the 11 public pages and none of the old addresses", async ({
    request,
  }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    const body = await response.text();
    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(urls.sort()).toEqual(SITEMAP_PATHS.map((p) => `https://www.routeflow.info${p}`).sort());
    for (const gone of ["wholesalers", "retailers", "book-a-demo", "sign-in"]) {
      expect(body, `sitemap still lists /${gone}`).not.toContain(`/${gone}<`);
    }
  });
});

// ─── T17 — W8 / S5: no heading level is skipped on the public pages ───────────

test.describe("T17 — W8 / S5: heading order on the public pages", () => {
  for (const route of [...READY_MADE_ROUTES, ...PUBLIC_ROUTES]) {
    test(`T17 — ${route}: one h1 first, no level skipped`, async ({ page }) => {
      await page.goto(route);
      // A heading's level is its aria-level when it has one, else its tag (how axe reads it).
      const levels = await page
        .locator("h1, h2, h3, h4, h5, h6, [role='heading']")
        .evaluateAll((els) =>
          els.map((el) => {
            const aria = parseInt(el.getAttribute("aria-level") ?? "", 10);
            return {
              level: Number.isInteger(aria) ? aria : Number(el.tagName.slice(1)),
              text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
            };
          }),
        );
      const skips: string[] = [];
      levels.forEach((heading, i) => {
        const previous = levels[i - 1];
        if (!previous && heading.level !== 1) skips.push(`first heading is h${heading.level}`);
        if (previous && heading.level > previous.level + 1) {
          skips.push(
            `h${previous.level} "${previous.text}" to h${heading.level} "${heading.text}"`,
          );
        }
      });
      expect(levels.filter((h) => h.level === 1)).toHaveLength(1);
      expect(skips, `${route} heading skips`).toEqual([]);
    });
  }
});

// ─── T19 — the ready-made pages (public/site): home, pricing, product, landing, the four deep pages, Company and Contact ──
//
// Served by rewrites in next.config.mjs. They bring their own header, footer, styles, scripts and
// font; these read the pages themselves, signed out.

test.describe("T19 — ready-made pages are served, linked and clean", () => {
  const PAGES: Array<[string, RegExp, boolean]> = [
    ["/", /We make wholesalers’ lives easier/, true],
    ["/pricing", /Pricing \| RouteFlow/, true],
    ["/product", /Product \| RouteFlow/, true],
    ["/landing", /Software for wholesalers and distributors/, false],
    ["/getting-started", /Getting started \| RouteFlow/, true],
    ["/does-and-doesnt", /What it does and doesn’t do \| RouteFlow/, true],
    ["/data-in-and-out", /Data in and out \| RouteFlow/, true],
    ["/security", /Security and your data \| RouteFlow/, true],
    ["/company", /Company \| RouteFlow/, true],
    ["/contact", /Contact \| RouteFlow/, true],
  ];

  for (const [route, title, indexable] of PAGES) {
    test(`T19 — ${route}: 200 as HTML, titled, indexable=${indexable}, links to the real sign-up`, async ({
      page,
    }) => {
      const response = await page.goto(route);
      expect(response?.status(), `${route} status`).toBe(200);
      expect(response?.headers()["content-type"]).toContain("text/html");
      expect(response?.headers()["content-security-policy"], "same policy as the app").toContain(
        "default-src 'self'",
      );
      await expect(page).toHaveTitle(title);
      const robots = await page.locator('meta[name="robots"]').count();
      expect(robots > 0, `${route} noindex`).toBe(!indexable);
      await expect(page.locator('a[href="/signup"]').first()).toBeAttached();
    });
  }

  test("T19 — no script or style is blocked by the policy and no page raises an error", async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) {
        problems.push(m.text());
      }
    });
    page.on("pageerror", (e) => problems.push(e.message));
    for (const [route] of PAGES) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
    }
    expect(problems).toEqual([]);
  });

  test("T19 — the animation script runs on the home page, and the file behind it stays out of search", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as { gsap?: unknown }).gsap));
    await expect(page.locator("html")).toHaveClass(/\bjs\b/);
    const direct = await page.request.get("/site/home.html");
    expect(direct.headers()["x-robots-tag"]).toBe("noindex");
  });

  test("T19 — every internal link on the ready-made pages answers", async ({ page, request }) => {
    const found = new Set<string>();
    for (const [route] of PAGES) {
      await page.goto(route);
      const hrefs = await page
        .locator('a[href^="/"]')
        .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      for (const href of hrefs) found.add(href.split("#")[0] || "/");
    }
    for (const real of ["/signup", "/login", "/buyer/login", "/terms", "/privacy"]) {
      expect(found.has(real), `${real} linked`).toBe(true);
    }
    const failures: Array<{ href: string; status: number }> = [];
    for (const href of found) {
      const status = (await request.get(href)).status();
      if (status >= 400) failures.push({ href, status });
    }
    expect(failures).toEqual([]);
  });

  test("T19 — visit counts: the ready-made pages carry Umami exactly when the React pages do, never twice", async ({
    request,
  }) => {
    // The same build variable decides both. With a site ID every page has Umami's script once and
    // the pageview script after it; without one, neither. (/privacy is a React page.)
    const reactPage = await (await request.get("/privacy")).text();
    const counted = reactPage.includes(UMAMI_TRACKER_URL);
    for (const [route] of PAGES) {
      const body = await (await request.get(route)).text();
      const tags = body.split(UMAMI_TRACKER_URL).length - 1;
      expect(tags, `${route} Umami script tags`).toBe(counted ? 1 : 0);
      expect(body.includes('src="/site/analytics.js"'), `${route} pageview script`).toBe(counted);
      expect(body.includes('data-auto-track="false"'), `${route} no auto-track`).toBe(counted);
    }
  });

  test("T19 — the contact address reads right on the home page", async ({ page }) => {
    await page.goto("/");
    const mails = page.locator('a[href^="mailto:"]');
    expect(await mails.count()).toBeGreaterThan(0);
    for (const a of await mails.all()) {
      await expect(a).toHaveAttribute("href", "mailto:hello@routeflow.info");
    }
  });
});

// ─── T21 — the motion does not depend on the visitor's motion setting ───────
// Owner ruling 2026-11-03: the wheel comes apart on scroll for everyone. The OS "reduce motion" setting, the
// footer switch and ?motion=on are gone; a computer with animations off used to get a still dial and a page
// 8,000 px shorter (no ScrollTriggers at all). Only no-JS and a window under 500 px tall keep the still.
test.describe("T21 — the motion does not depend on the visitor's motion setting", () => {
  const VIEWS = [
    { name: "1440", width: 1440, height: 900 },
    { name: "390", width: 390, height: 844 },
  ];

  const measure = (page: import("@playwright/test").Page) =>
    page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      triggers: (
        window as unknown as { ScrollTrigger?: { getAll(): unknown[] } }
      ).ScrollTrigger?.getAll().length,
      live: !!document.querySelector(".rfw-live"),
      still: !!document.querySelector(".rfw--static"),
      js: document.documentElement.className,
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));

  const load = async (
    browser: import("@playwright/test").Browser,
    view: (typeof VIEWS)[number],
    reducedMotion: "reduce" | "no-preference",
    seed?: () => void,
  ) => {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      reducedMotion,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (seed) await page.addInitScript(seed);
    await page.goto("/", { waitUntil: "load" });
    await page.waitForFunction(() => !!document.querySelector(".rfw-live, .rfw--static"), null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);
    return { context, page, errors };
  };

  for (const view of VIEWS) {
    test(`T21 — reduce at ${view.name}: the page is built the same as with no preference`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const normal = await load(browser, view, "no-preference");
      const a = await measure(normal.page);
      await normal.context.close();
      const reduced = await load(browser, view, "reduce");
      const b = await measure(reduced.page);
      expect(b.reduce, "the browser really reports reduced motion").toBe(true);
      expect(b.still, "no still dial").toBe(false);
      expect(b.live, "the live wheel").toBe(true);
      expect(b.triggers, "ScrollTriggers").toBe(a.triggers);
      expect(b.triggers ?? 0).toBeGreaterThan(20);
      expect(Math.abs(b.height - a.height), "page height").toBeLessThanOrEqual(4);
      expect(b.js).toContain("js-motion");
      expect(b.js).not.toMatch(/\brm\b|motion-on/);
      expect(reduced.errors).toEqual([]);
      await reduced.context.close();
    });

    test(`T21 — reduce at ${view.name}: the wheel pieces move apart on scroll`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const { context, page, errors } = await load(browser, view, "reduce");
      const box = await page.evaluate(() => {
        const r = document.querySelector(".rfw")!.getBoundingClientRect();
        return { top: Math.round(r.top + scrollY), height: Math.round(r.height) };
      });
      expect(box.height, "the wheel section is tall (it pins)").toBeGreaterThan(view.height * 1.5);
      // A coarse picture of the canvas: where it is not white/grey, on a 4-px grid.
      const snap = () =>
        page.evaluate(() => {
          const cv = document.querySelector<HTMLCanvasElement>(".rfw-cv")!;
          const c = cv.getContext("2d")!;
          const { width: W, height: H } = cv;
          const d = c.getImageData(0, 0, W, H).data;
          const cells: number[] = [];
          for (let y = 0; y < H; y += 8)
            for (let x = 0; x < W; x += 8) {
              const i = (y * W + x) * 4;
              cells.push(d[i]! + d[i + 1]! + d[i + 2]!);
            }
          return cells;
        });
      const at = async (f: number) => {
        await page.evaluate(
          (y) => {
            document.documentElement.style.scrollBehavior = "auto";
            scrollTo(0, y);
          },
          box.top + f * (box.height - view.height),
        );
        await page.waitForTimeout(1500);
        return snap();
      };
      const rest = await at(0);
      let moved = 0;
      for (const f of [0.2, 0.4, 0.6, 0.8]) {
        const now = await at(f);
        const changed = now.filter((v, i) => Math.abs(v - rest[i]!) > 60).length / now.length;
        moved = Math.max(moved, changed);
      }
      expect(
        moved,
        "share of the canvas that changed while scrolling through the wheel",
      ).toBeGreaterThan(0.05);
      expect(errors).toEqual([]);
      await context.close();
    });
  }

  test("T21 — a leftover Reduce motion switch value in the browser changes nothing", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await load(browser, VIEWS[0]!, "no-preference", () => {
      try {
        localStorage.setItem("rf-rm", "1");
      } catch {
        /* storage blocked: nothing to leave behind */
      }
    });
    const m = await measure(page);
    expect(m.live).toBe(true);
    expect(m.triggers ?? 0).toBeGreaterThan(20);
    expect(m.js).not.toMatch(/\brm\b/);
    await context.close();
  });

  test("T21 — no page offers a Reduce motion switch, and ?motion=on is just a link", async ({
    request,
  }) => {
    for (const route of READY_MADE_ROUTES) {
      const body = await (await request.get(route)).text();
      expect(body, `${route} switch`).not.toMatch(/rm-toggle|data-rm|Reduce motion/);
    }
    const plain = await (await request.get("/")).text();
    const forced = await (await request.get("/?motion=on")).text();
    expect(forced).toBe(plain);
  });
});
