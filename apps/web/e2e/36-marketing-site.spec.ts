/**
 * TP-E2E — marketing interface port + logo update (spec 36), project "marketing".
 *
 * Proves (post-deploy only, per test-plan.md "Harness notes" — NEVER run locally):
 *   T1  (R1 R2 R3 R8 R9 R12) — the 9 public routes render the port's copy/chrome.
 *   T2  (R2 R7 R8 R14)       — mobile (375) chrome + interactive pieces.
 *   T3  (R3)                 — every internal link on the 9 pages resolves.
 *   T12 (R11)                — a mobile UA still gets the marketing site on /pricing.
 *   T13 (R7 R14)             — below-the-fold sections reveal on scroll / reduced motion.
 *
 * CAPTURE NOTE: editorial-motion.tsx hides every reveal target below the fold
 * (.reveal-pending => opacity 0) until the IntersectionObserver fires, and a
 * full-page screenshot does not scroll. Any screenshot used to JUDGE the
 * below-fold sections must first scroll the page to the bottom, or run with
 * page.emulateMedia({ reducedMotion: "reduce" }) — otherwise those sections
 * capture blank (or mid-fade) and nothing about them can be judged.
 *
 * Signed-out throughout — no storageState, dependencies: [] on the "marketing"
 * project (playwright.config.ts). H1 copy is quoted verbatim from
 * local-assets/handoff/2026-09-06/redesign/marketing-inventory-redesign.md
 * (M1 §1-§3), except /privacy and /terms which use spec.md R9's INTERIM copy
 * ("Privacy information" / "Terms information") — R9 deliberately supersedes
 * M1 §2g's preview-banner placeholder text.
 *
 * Fails TODAY: none of the 9 routes serve the redesign yet (old marketing
 * site is still deployed), so every h1/nav/footer/mobile-sheet/tab/FAQ/link
 * assertion below misses on its own concrete value, and /pricing under a
 * mobile UA is still rewritten to the mobile build (R11 unfixed).
 */
import { test, expect, devices } from "@playwright/test";

// M1 §1 (home), §2a-§2f (dynamic slugs), §3 (404) — verbatim H1 text, italics
// flattened (Playwright's toHaveText normalises whitespace, not markup, but
// there is no markup left once innerText is read). /privacy + /terms per R9.
const H1_BY_ROUTE: Record<string, string> = {
  "/": "Turn scattered orders into organized deliveries.",
  "/product": "Orders. Deliveries. Accounts. Finally, connected.",
  "/wholesalers": "Get your team out of the daily delivery scramble.",
  "/retailers": "Restock your shelves. Skip the back and forth.",
  "/pricing": "A plan that fits your working day.",
  "/company": "For the people who keep local shelves stocked.",
  "/contact": "Let’s talk about your delivery day.",
  "/privacy": "Privacy information",
  "/terms": "Terms information",
};

const PUBLIC_ROUTES = Object.keys(H1_BY_ROUTE);

// M1 §4 site-header.tsx nav array — Contact is deliberately absent from the
// primary nav (R2, spec.md's port-notes call this out explicitly).
const NAV_ITEMS = ["Platform", "Distributors", "Retailers", "Pricing", "Company"];

// ─── T1 — the 9 public routes (R1 R2 R3 R8 R9 R12) ──────────────────────────

test.describe("T1 — public routes render the port's chrome + copy (R1 R2 R3 R8 R9 R12)", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`T1 — ${route}: 200, one h1 = M1 headline, header nav + footer chrome`, async ({
      page,
    }) => {
      const response = await page.goto(route);
      expect(response?.status(), `${route} status`).toBe(200);

      const h1 = page.locator("h1");
      await expect(h1, `${route} renders exactly one h1`).toHaveCount(1);
      await expect(h1).toHaveText(H1_BY_ROUTE[route]!);

      const nav = page.getByRole("navigation", { name: "Primary" });
      for (const item of NAV_ITEMS) {
        await expect(
          nav.getByRole("link", { name: item, exact: true }),
          `${route} header nav is missing "${item}"`,
        ).toBeVisible();
      }

      const footer = page.locator("footer");
      await expect(footer.getByRole("link", { name: "Privacy", exact: true })).toBeVisible();
      await expect(footer.getByRole("link", { name: "Terms", exact: true })).toBeVisible();
    });
  }

  test("T1 — /distributors redirects to /wholesalers (307/308)", async ({ request }) => {
    const response = await request.get("/distributors", { maxRedirects: 0 });
    expect([307, 308], `/distributors status was ${response.status()}`).toContain(
      response.status(),
    );
    const location = response.headers()["location"] ?? "";
    expect(location.endsWith("/wholesalers"), `redirect Location was "${location}"`).toBe(true);
  });

  test("T1 — a bogus marketing path 404s with the port's not-found H1", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist-e2e-36");
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("Let’s get you back on track.");
  });

  test("T1 — /privacy opts out of indexing (robots noindex, follow)", async ({ page }) => {
    await page.goto("/privacy");
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute("content", /noindex/i);
    await expect(robots).toHaveAttribute("content", /follow/i);
  });

  test("T1 — /contact shows the demo request form", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.getByRole("textbox", { name: /name/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /prepare my demo request/i })).toBeVisible();
  });

  test("T1 — /company credits the warehouse photo to Pexels", async ({ page }) => {
    await page.goto("/company");
    const credit = page.getByRole("link", { name: /pexels/i });
    await expect(credit).toBeVisible();
    await expect(credit).toHaveAttribute("href", /pexels\.com/i);
  });
});

// ─── T2 — mobile (375) chrome + interactions (R2 R7 R8 R14) ─────────────────

// `devices["iPhone 13"]` carries `defaultBrowserType`, which Playwright
// refuses inside a describe-scoped `test.use()` (it would force a new
// worker) — spread everything else (viewport, userAgent, isMobile, hasTouch).
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
const { defaultBrowserType: _desktopBrowserType, ...desktopChrome } = devices["Desktop Chrome"];

test.describe("T2 — mobile (375) chrome + interactions (R2 R7 R8 R14)", () => {
  test.use({ ...iPhone13 });

  test("T2 — the mobile sheet lists 9 links incl. Contact + both sign-ins + Book a demo, Escape closes it", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /open menu/i }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const expectedLinkNames = [
      "Platform",
      "Distributors",
      "Retailers",
      "Pricing",
      "Company",
      "Contact",
      "Distributor sign in",
      "Retailer sign in",
      "Book a demo",
    ];
    for (const name of expectedLinkNames) {
      await expect(
        sheet.getByRole("link", { name: new RegExp(name, "i") }),
        `mobile sheet is missing a "${name}" link`,
      ).toBeVisible();
    }
    await expect(sheet.getByRole("link"), "mobile sheet link count").toHaveCount(9);
    await expect(sheet.getByRole("link", { name: /book a demo/i })).toHaveAttribute(
      "href",
      "/book-a-demo",
    );

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("T2 — the /contact form prepares a mailto draft naming the company", async ({ page }) => {
    await page.goto("/contact");
    await page.getByRole("textbox", { name: /name/i }).fill("Ada");
    await page.getByRole("textbox", { name: /email/i }).fill("ada@example.com");
    await page.getByRole("textbox", { name: /company/i }).fill("Northwind");
    await page.getByRole("textbox", { name: /notes/i }).fill("A note about our workflow.");
    await page.getByRole("button", { name: /prepare my demo request/i }).click();

    await expect(page.getByRole("heading", { name: /your email draft is ready/i })).toBeVisible();

    const mailLink = page.getByRole("link", { name: /open email app/i });
    const href = await mailLink.getAttribute("href");
    expect(href, "mailto href present").toBeTruthy();
    expect(href!.startsWith("mailto:hello@routeflow.info?subject="), `href was "${href}"`).toBe(
      true,
    );
    expect(decodeURIComponent(href!)).toContain("RouteFlow demo request — Northwind");

    await page.getByRole("button", { name: /start a new draft/i }).click();
    await expect(page.getByRole("textbox", { name: /name/i })).toBeVisible();
  });

  test('T2 — /wholesalers "Plan the route" tab opens its panel', async ({ page }) => {
    await page.goto("/wholesalers");
    const routesTab = page.getByRole("tab", { name: /plan the route/i });
    await routesTab.click();

    await expect(routesTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toBeVisible();
  });

  test("T2 — the home FAQ keeps only one item open at a time", async ({ page }) => {
    await page.goto("/");
    const items = page.locator("#main-content details");
    await expect(items, "general FAQ has 5 items").toHaveCount(5);

    await items.nth(1).locator("summary").click();
    await items.nth(2).locator("summary").click();

    await expect(items.nth(2), "the third item (index 2) should be open").toHaveJSProperty(
      "open",
      true,
    );
    await expect(items.nth(1), "the second item (index 1) should have closed").toHaveJSProperty(
      "open",
      false,
    );
    await expect(page.locator("#main-content details[open]"), "exactly one item open").toHaveCount(
      1,
    );
  });
});

// The desktop `.nav-login` dropdown (site-header.tsx) is `display: none` at
// phone widths (marketing.css); the mobile sheet carries both sign-in links
// instead (covered by the T2 sheet test above), so this assertion needs a
// desktop viewport to find the trigger at all.
test.describe("T2 — desktop sign-in menu (R2 R7 R8 R14)", () => {
  test.use({ ...desktopChrome });

  test('T2 — the "Sign in" control offers Distributor -> /login and Retailer -> /buyer/login', async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /sign in/i }).click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /distributor sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
    await expect(menu.getByRole("menuitem", { name: /retailer sign in/i })).toHaveAttribute(
      "href",
      "/buyer/login",
    );
  });
});

// ─── T3 — every internal link on the 9 pages resolves (R3) ──────────────────

test.describe("T3 — every internal link on the 9 public pages resolves (R3)", () => {
  test('T3 — crawl a[href^="/"] on the 9 pages, expect status < 400 incl. auth routes', async ({
    page,
    request,
  }) => {
    const found = new Set<string>();
    for (const route of PUBLIC_ROUTES) {
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
    expect(found.size, "at least one internal link found across the 9 pages").toBeGreaterThan(0);

    const results: { href: string; status: number }[] = [];
    for (const href of Array.from(found)) {
      const response = await request.get(href);
      results.push({ href, status: response.status() });
    }

    const failures = results.filter((r) => r.status >= 400);
    expect(failures, `broken internal links: ${JSON.stringify(failures)}`).toEqual([]);

    for (const authPath of ["/login", "/signup"]) {
      const hit = results.find((r) => r.href === authPath);
      expect(
        hit?.status,
        `${authPath} was not linked from any of the 9 pages, or did not 200`,
      ).toBe(200);
    }

    const buyerHits = results.filter((r) => r.href.startsWith("/buyer"));
    expect(buyerHits.length, "at least one /buyer/* link found across the 9 pages").toBeGreaterThan(
      0,
    );
    for (const hit of buyerHits) {
      expect(hit.status, `${hit.href} status`).toBe(200);
    }
  });
});

// ─── T12 — mobile UA + /pricing still serves marketing (R11) ────────────────

test.describe("T12 — a mobile UA still gets the marketing site on /pricing (R11)", () => {
  test("T12 — /pricing under a mobile UA returns 200 with the pricing H1", async ({ request }) => {
    const response = await request.get("/pricing", {
      headers: { "User-Agent": devices["iPhone 13"].userAgent },
    });
    expect(response.status()).toBe(200);

    const body = await response.text();
    // The rendered h1 splits across a <br /> + <em>, so the raw HTML never
    // contains the full joined H1_BY_ROUTE string — match the text run
    // before the break instead.
    expect(
      body,
      "response body should contain the /pricing H1 lead-in (proves it is NOT the mobile build)",
    ).toContain("A plan that fits");
  });
});

// ─── T13 — below-the-fold sections reveal (R7 R14) ──────────────────────────

// editorial-motion.tsx marks every reveal target BELOW the fold at mount with
// `.reveal-pending` (marketing.css: `opacity: 0`) and only clears it when the
// IntersectionObserver fires. A full-page screenshot does NOT scroll, so an
// unscrolled capture shows those sections blank — a capture artifact, not a
// defect. These two tests pin both escape hatches so the blank state can never
// become real: scrolling clears every pending node, and reduced motion never
// sets one in the first place.
test.describe("T13 — below-the-fold sections reveal (R7 R14)", () => {
  test("T13 — scrolling to the bottom of / clears every .reveal-pending node and reaches opacity 1 (B504)", async ({
    page,
  }) => {
    await page.goto("/");

    const viewport = page.viewportSize()?.height ?? 720;
    const steps = Math.ceil(
      (await page.evaluate(() => document.body.scrollHeight)) / Math.max(viewport, 1),
    );
    for (let i = 0; i <= steps; i += 1) {
      await page.evaluate((y) => window.scrollTo(0, y), i * viewport);
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Give the 0.7s opacity transition (marketing.css) time to settle before
    // reading computed style, on top of the reveal-pending class removal.
    await page.waitForTimeout(1000);

    await expect(
      page.locator(".reveal-pending"),
      "a section stayed hidden after the page was scrolled end to end",
    ).toHaveCount(0);

    // B504: removing .reveal-pending used to leave computed opacity at 0
    // forever (no rule ever declared the revealed state) — the class-count
    // assertion above could not have caught that. Assert the actual visual
    // outcome, not just that the marker class is gone.
    const revealOpacities = await page
      .locator(".editorial-reveal")
      .evaluateAll((els) => els.map((el) => window.getComputedStyle(el).opacity));
    expect(revealOpacities.length, "reveal targets present on /").toBeGreaterThan(0);
    expect(
      revealOpacities.filter((o) => o !== "1"),
      "a .editorial-reveal node stayed transparent after its .reveal-pending class was cleared",
    ).toEqual([]);
  });

  test("T13 — capability cards and section headings are visible with JavaScript disabled (B504)", async ({
    browser,
  }) => {
    // editorial-motion.tsx only ever ADDS .reveal-pending via a client effect —
    // with JS disabled that effect never runs, so nothing should ever be
    // hidden. This is the progressive-enhancement guarantee itself, not an
    // inference from the JS source.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator(".reveal-pending")).toHaveCount(0);
    const card = page.locator(".capability-card").first();
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS("opacity", "1");
    const heading = page.locator(".section-heading").first();
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("opacity", "1");

    await context.close();
  });

  test("T13 — under prefers-reduced-motion the CTA block is opaque without scrolling", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    // The effect returns before it tags anything when reduced motion is on, so
    // no node ever carries `.editorial-reveal`/`.reveal-pending`; assert on the
    // reveal TARGETS themselves (the class list editorial-motion.tsx keys off).
    await expect(page.locator(".reveal-pending")).toHaveCount(0);

    const cta = page.locator(".cta-block").first();
    await expect(cta.getByRole("heading", { name: /put your workflow/i })).toBeVisible();

    const opacities = await page
      .locator(".cta-block, .audience-card, .buying-confidence")
      .evaluateAll((els) => els.map((el) => window.getComputedStyle(el).opacity));
    expect(opacities.length, "reveal targets present on /").toBeGreaterThan(0);
    expect(
      opacities.filter((o) => o !== "1"),
      "a reveal target was transparent under prefers-reduced-motion",
    ).toEqual([]);
  });
});

// ─── T14 — WCAG AA contrast for the B504-fixed roles (R7) ───────────────────

// WCAG relative-luminance contrast, computed in-page against the element's
// own resolved foreground color and its nearest ancestor with a non-transparent
// background-color (gradients/backdrop images resolve to a transparent
// background-color, so this walks up to the page's own white canvas — a
// conservative reference: the real composited background under a light glass
// panel is at least as light, so passing against white is not a false pass).
async function minContrast(locator: import("@playwright/test").Locator): Promise<number | null> {
  const values = await locator.evaluateAll((els) => {
    function parseColor(str: string): [number, number, number, number] | null {
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(",").map((s) => parseFloat(s.trim()));
      return [r!, g!, b!, a!];
    }
    function luminance([r, g, b]: [number, number, number, number]): number {
      const chan = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
    }
    return els.map((el) => {
      const fg = parseColor(getComputedStyle(el).color);
      if (!fg) return null;
      let node: Element | null = el;
      let bg: [number, number, number, number] | null = null;
      while (node) {
        const parsed = parseColor(getComputedStyle(node).backgroundColor);
        if (parsed && parsed[3] > 0) {
          bg = parsed;
          break;
        }
        node = node.parentElement;
      }
      if (!bg) bg = [255, 255, 255, 1];
      const lf = luminance(fg);
      const lb = luminance(bg);
      const lighter = Math.max(lf, lb);
      const darker = Math.min(lf, lb);
      return (lighter + 0.05) / (darker + 0.05);
    });
  });
  const real = values.filter((v): v is number => v !== null);
  return real.length ? Math.min(...real) : null;
}

const AA_NORMAL = 4.5;

test.describe("T14 — WCAG AA contrast for the B504-fixed roles (R7)", () => {
  for (const width of [1440, 390]) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test(`T14 — operation-story heading ("Know what is ready to go.") clears AA on /, /product, /wholesalers`, async ({
        page,
      }) => {
        let checked = 0;
        for (const route of ["/", "/product", "/wholesalers"]) {
          await page.goto(route);
          const heading = page.locator(".story-intro h3");
          const count = await heading.count();
          if (count === 0) continue;
          checked += count;
          const contrast = await minContrast(heading);
          expect(contrast, `${route} .story-intro h3 contrast`).not.toBeNull();
          expect(contrast!, `${route} .story-intro h3 contrast`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        expect(checked, "at least one operation-story heading was checked").toBeGreaterThan(0);
      });

      test('T14 — the purple AI-scan card ("Let AI scan the invoice." + its paragraph + its small label) clears AA on /, /product', async ({
        page,
      }) => {
        let checked = 0;
        for (const route of ["/", "/product"]) {
          await page.goto(route);
          const step = page.locator("li.ai-assisted-step");
          if ((await step.count()) === 0) continue;
          const heading = step.locator("h3");
          const paragraph = step.locator("p");
          // B507: the card's `small` label was left uncovered by B504's fix
          // for its h3/p siblings — same card, same tie, same fix, just
          // never extended to it (round-2 measured 1.59-1.60:1).
          const small = step.locator("small");
          checked += (await heading.count()) + (await paragraph.count()) + (await small.count());
          const headingContrast = await minContrast(heading);
          const paragraphContrast = await minContrast(paragraph);
          const smallContrast = await minContrast(small);
          expect(headingContrast, `${route} .ai-assisted-step h3 contrast`).not.toBeNull();
          expect(headingContrast!, `${route} .ai-assisted-step h3 contrast`).toBeGreaterThanOrEqual(
            AA_NORMAL,
          );
          expect(paragraphContrast, `${route} .ai-assisted-step p contrast`).not.toBeNull();
          expect(
            paragraphContrast!,
            `${route} .ai-assisted-step p contrast`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
          expect(smallContrast, `${route} .ai-assisted-step small contrast`).not.toBeNull();
          expect(
            smallContrast!,
            `${route} .ai-assisted-step small contrast`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        expect(checked, "at least one AI-scan card was checked").toBeGreaterThan(0);
      });

      test("T14 — muted caption color (--g-soft) clears AA on /, /pricing, /product, /wholesalers", async ({
        page,
      }) => {
        const CAPTION_SELECTOR =
          ".story-chapter-count, .story-disclaimer, .pricing-footnote, .sample-note, .capability-scope, .record-note p, .connection-diagram > p, .form-disclosure";
        let checked = 0;
        for (const route of ["/", "/pricing", "/product", "/wholesalers"]) {
          await page.goto(route);
          const captions = page.locator(CAPTION_SELECTOR);
          const count = await captions.count();
          if (count === 0) continue;
          checked += count;
          const contrast = await minContrast(captions);
          expect(contrast, `${route} caption contrast`).not.toBeNull();
          expect(contrast!, `${route} caption contrast`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        expect(checked, "at least one caption was checked").toBeGreaterThan(0);
      });

      test("T14 — the difference-section intro paragraphs clear AA on /", async ({ page }) => {
        await page.goto("/");
        const paragraphs = page.locator(
          ".difference-section .split-heading > p, .difference-section .difference-footer > p",
        );
        const count = await paragraphs.count();
        expect(count, "difference-section paragraphs present on /").toBeGreaterThan(0);
        const contrast = await minContrast(paragraphs);
        expect(contrast).not.toBeNull();
        expect(contrast!).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    });
  }
});

// ─── T15 — WCAG AA contrast for the B507-fixed roles (round-2 sweep) ────────
//
// The B507 round-2 recheck found 8 unique failures (12 total across the
// pages it hit) that survived B504: some the same specificity-tie mechanism
// on a sibling element B504 never covered, some plain token/rule-level
// undertones one shade too light for a particular background. See
// glass.css/glass-site.css/marketing.css for the per-selector root-cause
// notes next to each fix.

test.describe("T15 — WCAG AA contrast for the B507-fixed roles", () => {
  for (const width of [1440, 390]) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("T15 — the operation-story scrubber's explanation text clears AA on /, /wholesalers", async ({
        page,
      }) => {
        let checked = 0;
        for (const route of ["/", "/wholesalers"]) {
          await page.goto(route);
          const paragraph = page.locator(".story-controls .story-explanation > p");
          const count = await paragraph.count();
          if (count === 0) continue;
          checked += count;
          const contrast = await minContrast(paragraph);
          expect(
            contrast,
            `${route} .story-controls .story-explanation > p contrast`,
          ).not.toBeNull();
          expect(
            contrast!,
            `${route} .story-controls .story-explanation > p contrast`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        expect(checked, "at least one story-controls explanation was checked").toBeGreaterThan(0);
      });

      test("T15 — the workflow-tour record-note's label (--g-eyebrow) clears AA on /wholesalers", async ({
        page,
      }) => {
        await page.goto("/wholesalers");
        const span = page.locator(".record-note > span");
        const count = await span.count();
        expect(count, "record-note span present on /wholesalers").toBeGreaterThan(0);
        const contrast = await minContrast(span);
        expect(contrast).not.toBeNull();
        expect(contrast!).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      test("T15 — the audience-card links (distributors + retailers) clear AA on /", async ({
        page,
      }) => {
        await page.goto("/");
        const links = page.locator(
          ".audience-card.distributors .text-link, .audience-card.retailers .text-link",
        );
        const count = await links.count();
        expect(count, "audience-card links present on /").toBeGreaterThan(0);
        const contrast = await minContrast(links);
        expect(contrast).not.toBeNull();
        expect(contrast!).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      test("T15 — the product-passport bar's trailing label clears AA on /, /product, /wholesalers", async ({
        page,
      }) => {
        let checked = 0;
        for (const route of ["/", "/product", "/wholesalers"]) {
          await page.goto(route);
          const span = page.locator(".passport-bottom > span:last-child");
          const count = await span.count();
          if (count === 0) continue;
          checked += count;
          const contrast = await minContrast(span);
          expect(contrast, `${route} .passport-bottom > span:last-child contrast`).not.toBeNull();
          expect(
            contrast!,
            `${route} .passport-bottom > span:last-child contrast`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        expect(checked, "at least one passport-bottom label was checked").toBeGreaterThan(0);
      });

      test("T15 — the retailer photo's caption clears AA on /retailers", async ({ page }) => {
        await page.goto("/retailers");
        const caption = page.locator(".retailer-art figcaption");
        const count = await caption.count();
        expect(count, "retailer-art figcaption present on /retailers").toBeGreaterThan(0);
        const contrast = await minContrast(caption);
        expect(contrast).not.toBeNull();
        expect(contrast!).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    });
  }
});
