/**
 * WP3 (15): Stock count UI — session lifecycle rendered live, discard-only.
 *
 * Role: OPERATOR. READ-ONLY-OR-DISCARD BY CONTRACT: starts a real stock-count
 * session (there is no mock-only path — the tab always talks to the live
 * API), counts exactly one line, opens the review screen to read its columns,
 * then Discards the session before the test ends. Discard never applies a
 * count to stock — `StockCountTab.onDiscardSession` calls
 * `POST /inventory/stock-counts/:id/discard`, never commit — so this spec has
 * ZERO stock impact by construction. The session row itself survives as
 * DISCARDED history (same tolerated residue as an estimate left CONVERTED in
 * feature-smoke.mjs's S6) — nothing about that carries stock, cost, or money
 * state, so no cleanup call is made for it.
 *
 * "Disappears from Continue count" is verified against the network response
 * the discard's cache invalidation triggers (`GET /inventory/stock-counts?
 * status=OPEN`), not by scanning the DOM for a name — every session on this
 * tab renders as "(untitled)" absent a name, so two open sessions are
 * visually indistinguishable and only the response body can prove which one
 * is gone.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const SCAN_PLACEHOLDER = "Scan with USB or webcam, or type to search";

test.describe("Operator — Stock count UI (WP3-15)", () => {
  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    // Deep-links straight onto the Stock Count tab — `activeTab` initializes
    // from `?tab=count` on first render (see inventory/page.tsx), so this is
    // equivalent to clicking the tab trigger but avoids depending on it.
    await page.goto("/inventory?tab=count");
    await expect(page.getByPlaceholder(SCAN_PLACEHOLDER)).toBeVisible({ timeout: 15_000 });
  });

  /** Types into the scan/search box and clicks the first suggestion — the
   *  manual-add path (as opposed to a hardware/webcam barcode scan). Tries a
   *  couple of common letters since the tenant's actual catalog is unknown. */
  async function addAnyProductLine(page: Page): Promise<void> {
    const search = page.getByPlaceholder(SCAN_PLACEHOLDER);
    await search.fill("e");
    let firstOption = page.getByRole("option").first();
    const appeared = await firstOption
      .waitFor({ state: "visible", timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      await search.fill("a");
      firstOption = page.getByRole("option").first();
    }
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    await firstOption.click();
  }

  /** A leftover OPEN session from a prior run (or a real operator) pops a
   *  "keep this new one or switch" dialog the instant the start-session
   *  response lands — dismiss it so it doesn't sit on top of the toolbar
   *  underneath for the rest of the test. */
  async function dismissOtherOpenWarningIfAny(page: Page): Promise<void> {
    const heading = page.getByRole("heading", { name: "Another count is already open" });
    const appeared = await heading
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await page.getByRole("button", { name: "Keep this new count" }).click();
    }
  }

  test("COUNT-01 start, count a line, review the columns, discard — no open session, no stock impact", async ({
    page,
  }) => {
    // Capture the session id from the POST that starts it (fired by
    // `ensureSession()` the moment the first suggestion is picked) — the only
    // way to later prove THIS session, not just any session, left the OPEN list.
    let sessionId: string | null = null;
    page.on("response", (resp) => {
      if (resp.request().method() !== "POST") return;
      if (!/\/api\/v1\/inventory\/stock-counts(\?.*)?$/.test(resp.url())) return;
      resp
        .json()
        .then((body: { id?: string }) => {
          if (resp.ok() && body?.id) sessionId = body.id;
        })
        .catch(() => {});
    });

    await addAnyProductLine(page);
    await expect.poll(() => sessionId, { timeout: 15_000 }).not.toBeNull();
    await dismissOtherOpenWarningIfAny(page);

    // The line renders with a counted qty (qtyPerScan defaults to 1).
    const countedRow = page.locator("tbody tr").first();
    await expect(countedRow).toBeVisible({ timeout: 15_000 });
    const countedInput = countedRow.locator("td").nth(3).locator("input");
    await expect(countedInput).toHaveValue(/[1-9]/, { timeout: 10_000 });

    // The autosave queue's "n unsaved" pill resolves to "All changes saved".
    await expect(page.getByText(/all changes saved/i)).toBeVisible({ timeout: 20_000 });

    // Open Review and assert the expected → counted → variance columns render.
    const reviewButton = page.getByRole("button", { name: "Review & Commit" });
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();

    const reviewHeading = page.getByRole("heading", { name: "Review stock count" });
    await expect(reviewHeading).toBeVisible({ timeout: 10_000 });
    // Nearest ancestor panel with its own class — the background count table
    // ALSO has "Expected"/"Counted" headers, so unscoped text queries here
    // would hit both and fail Playwright's strict-mode single-match rule.
    const reviewModal = reviewHeading.locator(
      "xpath=ancestor::div[contains(@class,'rounded-xl')][1]",
    );
    await expect(reviewModal.getByText("Expected", { exact: true })).toBeVisible();
    await expect(reviewModal.getByText("Counted", { exact: true })).toBeVisible();
    await expect(reviewModal.getByText("Variance", { exact: true })).toBeVisible();

    // Close the review screen — never commits.
    await reviewModal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(reviewHeading).toHaveCount(0);

    // Discard the session (confirm() dialog auto-accepted) and prove it
    // leaves the OPEN list via the network response the invalidation causes,
    // not via DOM text every untitled session shares.
    const openListResponse = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        /\/api\/v1\/inventory\/stock-counts\?/.test(r.url()) &&
        /status=OPEN/.test(r.url()),
      { timeout: 20_000 },
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Discard session" }).click();
    const listResp = await openListResponse;
    const listBody: { data?: Array<{ id: string }> } = await listResp.json();
    const stillOpen = (listBody.data ?? []).some((s) => s.id === sessionId);
    expect(stillOpen).toBe(false);

    // Local state cleared too — back to the empty scan state.
    await expect(page.getByText("No items scanned yet")).toBeVisible({ timeout: 15_000 });

    // The history list page loads (and, incidentally, is where this run's
    // DISCARDED session lives on — the only residue this spec leaves).
    await page.getByRole("link", { name: "Count history" }).click();
    await expect(page).toHaveURL(/\/inventory\/stock-counts/);
    await expect(page.getByRole("heading", { name: "Stock Counts" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Status", { exact: true })).toBeVisible();
  });
});
