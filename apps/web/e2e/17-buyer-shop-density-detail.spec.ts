/**
 * Buyer shop — grid density control + product detail page
 *
 * Covers: BSD-01 (2026-08-20 plan `.claude/pipeline/plans/2026-08-20-buyer-shop-density-and-detail.md`)
 * Role: OPERATOR (customer + invite setup) → BUYER (email-based auth, self-register)
 *
 * SELF-CONTAINED, mirroring 04-buyer-portal.spec.ts's register→invite→accept dance so this
 * depends on no pre-existing buyer or customer:
 *   1. Operator on the e2e tenant creates a fresh customer and sends a portal invite,
 *      capturing the invite token from the `POST .../portal-invite` response body (its
 *      `inviteUrl` field) rather than scraping the DOM for it.
 *   2. A fresh buyer registers with `?redirect=/buyer/invite/<token>` (the placeholders below —
 *      field placeholders, button labels — are copied from the WORKING 04 flow) and accepts.
 *   3. Selects the seller (sets the buyer's activeSeller + persists it), then exercises the
 *      shop grid: density control (persistence across reload) and tile → detail navigation.
 *
 * Cart is client-side localStorage only — no server writes. The Add step at the end clears
 * storage so nothing lingers for the next run.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";

test.describe("Buyer shop density + product detail", () => {
  test("BSD-01 density persists on reload; tile opens detail; Add updates cart badge", async ({
    page,
    context,
  }) => {
    const stamp = Date.now();
    const businessName = `E2E-Shop-${stamp}`;
    const buyerName = "E2E Shop Buyer";
    const buyerEmail = `e2e_buyer_shop_${stamp}@example.com`;
    const buyerPass = "BuyerE2E@2026!";

    // ── 1. Operator: create a customer + send a portal invite ────────────────
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await loginAsOperator(page);

    await page.goto("/customers");
    await page.getByRole("button", { name: "New Customer" }).first().click();
    await page.getByLabel("Business Name").fill(businessName);
    await page.getByLabel("Contact Name").fill(buyerName);
    await page.getByLabel("Street").fill("100 E2E Test Way");
    await page.getByLabel("City").fill("Austin");
    await page.getByLabel("ZIP Code").fill("78701");
    await page.getByRole("button", { name: "Create Customer" }).click();
    // Modal closes on success — more reliable than racing the toast's fade timer.
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 15_000 });

    // Find the new customer (unique E2E-prefixed name — exactly one match) and open it.
    // The search is debounced + server-side, so `.first()` right after fill() would resolve
    // against the still-unfiltered list and could open a DIFFERENT customer (and then send a
    // real portal invite to it). Wait for the filtered row, then click inside THAT row.
    await page.getByPlaceholder("Name, business or phone…").fill(businessName);
    const customerRow = page.getByRole("row", { name: businessName });
    await expect(customerRow).toBeVisible({ timeout: 20_000 });
    await customerRow.getByRole("button", { name: "View customer" }).click();
    await page.waitForURL(/\/customers\/.+/, { timeout: 15_000 });

    // Send the invite with an override email (this fresh customer has none on file) and
    // capture the token from the response body — the detail page never renders the raw
    // invite link, so scraping the DOM for it (as 04's BY-07 does) is not reliable here.
    await expect(page.getByLabel("Invite email")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Invite email").fill(buyerEmail);
    const inviteResponsePromise = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().includes("/portal-invite"),
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Send Portal Invite" }).click();
    const inviteResponse = await inviteResponsePromise;
    const inviteBody = (await inviteResponse.json()) as { inviteUrl?: string };
    const inviteToken = inviteBody.inviteUrl?.split("/buyer/invite/")[1];
    expect(inviteToken, "portal-invite response must include inviteUrl").toBeTruthy();

    // ── 2. Fresh buyer: register (redirect param carries the invite) → accept ─
    // Placeholders below are load-bearing — copied verbatim from 04-buyer-portal.spec.ts's
    // working BY-01 registration flow.
    const inviteHref = `/buyer/invite/${inviteToken}`;
    await page.goto(`/buyer/register?redirect=${encodeURIComponent(inviteHref)}`);
    await page.getByPlaceholder("Enter your full name").fill(buyerName);
    await page.getByPlaceholder("Enter your email").fill(buyerEmail);
    await page.getByPlaceholder("8+ chars, upper & lower case, number or symbol").fill(buyerPass);
    await page.getByPlaceholder("Re-enter your password").fill(buyerPass);
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.waitForURL(/\/buyer\/invite\//, { timeout: 20_000 });

    await page.getByRole("button", { name: /accept invite/i }).click();
    await page.waitForURL(/\/buyer\/portal(\?|$)/, { timeout: 20_000 });

    // Select the seller — this both sets activeSeller (persisted to localStorage, so a plain
    // page.goto to a seller sub-route later still has it) and navigates to its /orders page.
    const sellerCard = page.locator("[class*='seller'], [class*='card'] button").first();
    await expect(sellerCard).toBeVisible({ timeout: 15_000 });
    await sellerCard.click();
    await page.waitForURL(/\/buyer\/portal\/.+\/orders/, { timeout: 15_000 });
    const sellerSlug = page.url().split("/buyer/portal/")[1]?.split("/")[0];
    expect(sellerSlug).toBeTruthy();

    // ── 3. Shop renders ────────────────────────────────────────────────────────
    await page.goto(`/buyer/portal/${sellerSlug}/shop`);
    const grid = page.getByTestId("product-grid");
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("product-tile").first()).toBeVisible({ timeout: 15_000 });
    expect(await page.getByTestId("product-tile").count()).toBeGreaterThan(0);

    // Default density is "md" — one notch denser than the old hardcoded grid.
    await expect(grid).toHaveClass(/xl:grid-cols-5/);

    // ── 4. Density: Compact survives reload; Large restores the old grid ──────
    // Assert on `2xl:grid-cols-7` — a class ONLY the "sm" map entry carries. A bare
    // /grid-cols-3/ would also match the default "md" string (`sm:grid-cols-3`), so the
    // post-reload check would pass even with persistence broken.
    await page.getByTestId("density-sm").click();
    await expect(grid).toHaveClass(/2xl:grid-cols-7/);
    await page.reload();
    await expect(grid).toHaveClass(/2xl:grid-cols-7/, { timeout: 20_000 });

    await page.getByTestId("density-lg").click();
    await expect(grid).toHaveClass(/grid-cols-2/);
    await expect(grid).toHaveClass(/xl:grid-cols-4/);

    // ── 5. Detail: first tile navigates to its own detail page ───────────────
    const firstTileLink = page.getByTestId("product-tile-link").first();
    await expect(firstTileLink).toBeVisible({ timeout: 15_000 });
    await firstTileLink.click();
    await page.waitForURL(/\/shop\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("product-detail-name")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("product-detail-price")).toBeVisible();

    // ── 6. Add on the detail page → the floating cart badge appears ───────────
    // The action slot is Add / QtyStepper / Notify-me depending on cart+stock state; this
    // fresh cart + the first catalog tile should show Add, but the tenant's seed data can
    // vary, so this stays a soft assertion like 04's data-dependent tests (BY-09 etc.).
    const addButton = page.getByTestId("product-detail-add");
    const hasAdd = await addButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasAdd) {
      await addButton.click();
      // The badge counts total UNITS (`totalQty`), not lines — a boxed product correctly adds
      // one box = `unitsPerBox` units, so the count must stay qty-agnostic here. Pinning it to
      // "1 items" would encode the boxed-Add bug and fail once Add is correct.
      await expect(page.getByRole("button", { name: /^View cart \(\d+ items\)$/ })).toBeVisible({
        timeout: 10_000,
      });
    } else {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "First product wasn't in an Add state (already carted/OOS) — density + nav already verified.",
      });
    }

    // Cart is localStorage-only — no server writes happened. Clear it so nothing lingers.
    await page.evaluate(() => {
      try {
        localStorage.clear();
      } catch {
        // Ignore SecurityError on about:blank/cross-origin
      }
    });
  });
});
