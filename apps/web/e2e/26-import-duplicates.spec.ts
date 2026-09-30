/**
 * F17 · Payments-import duplicate reporting on the web surface (R5, spec 26).
 *
 * REG-B99 (web leg): `importPayments` now returns `duplicates` beside
 * imported/skipped — the server half is proven in
 * apps/api/src/import/import-robustness.spec.ts. This spec proves the other
 * half: that /settings/import actually SURFACES the count, in the success
 * toast summary and in the Customer Payments card's result badge. Without it
 * the badge could render nothing (or throw) with every other F17 gate green.
 *
 * FULLY MOCKED — NO WRITES: POST /import/payments is intercepted with
 * page.route BEFORE the page is ever opened and answered from a canned body,
 * the same technique 02-operator.spec.ts uses for the vendor-bill scan. The
 * CSV picked below never leaves the browser, so no payment, invoice or
 * invoice status on the tenant is touched.
 *
 * Deliberately NO build-age self-skip. A build that PREDATES R5 and a build
 * that has REGRESSED it are indistinguishable on this page — both render the
 * summary with no duplicates clause and no badge — so a skip keyed on that
 * state would swallow the exact regression this spec exists to catch and
 * report it as SKIPPED instead of FAILED. 12-search-back-nav.spec.ts can
 * self-skip because it has a signal (a `?search=` URL param) SEPARATE from
 * what it asserts; this result has no such signal, so the duplicates line is
 * asserted, not probed (25-migration-hub.spec.ts makes the same call).
 * Staleness is handled one layer up instead: ci.yml's "Wait for the deployed
 * app to match this commit" gate FAILS the job rather than continuing unless
 * the deployed web build is code-identical to the commit under test.
 *
 * Role: OPERATOR (storage state from the "import-duplicates" project). Runs
 * against the DEPLOYED build (T2, proven-pending-deploy per the build plan).
 */
import { test, expect, type Page } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

/**
 * The Customer Payments import card. Each card labels its own button
 * ("Import <section>"), which identifies the card uniquely; the card root is
 * the `rounded-xl` wrapper around it — the one element that holds BOTH the
 * card's hidden file input and its result badge.
 */
function paymentsCard(page: Page) {
  return page
    .locator("div.rounded-xl")
    .filter({ has: page.getByRole("button", { name: "Import Customer Payments" }) })
    .first();
}

test("REG-B99 (web leg): the payments import result reports duplicates in the toast summary and the card badge", async ({
  page,
}) => {
  // Canned importPayments body. `duplicates` is re-read on every call so the
  // second import below can exercise the singular wording.
  let duplicates = 2;
  await page.route(/\/import\/payments(\?.*)?$/, (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ imported: 0, skipped: 1, duplicates, errors: [] }),
    }),
  );

  await page.goto("/dashboard");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  // Confirm the session actually resolves before spending the rest of the test
  // on a page that will otherwise just bounce to /login.
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  test.skip(!res.ok(), `session token did not authenticate (${res.status()})`);

  await page.goto("/settings/import");
  const card = paymentsCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Pick a file (the input is hidden by design — 02-operator drives the scan
  // modal's hidden input the same way) and import. The request never leaves
  // the browser: the route above fulfills it.
  await card.locator('input[type="file"]').setInputFiles({
    name: "payments-reupload.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Invoice Number,Amount\n"),
  });
  await card.getByRole("button", { name: "Import Customer Payments" }).click();

  // The toast is the ephemeral half (4 s), so assert it first. The toast
  // viewport is Radix's role="region" labelled "Notifications (F8)" and each
  // toast inside it is an <li> (21-destructive-guards.spec.ts documents why
  // scoping through the region is what excludes the aria-live announcer
  // mirror). A build with no duplicates clause never matches the filter below,
  // so this assertion — not a skip — is what fails on a regression.
  const resultToast = page
    .getByRole("region", { name: /notifications/i })
    .getByRole("listitem")
    .filter({ hasText: /duplicate/i })
    .first();
  await expect(resultToast).toContainText("0 records imported, 1 skipped, 2 duplicates skipped", {
    timeout: 15_000,
  });

  // The card's result badge is the persistent half — it survives the toast's
  // fade. `exact` keeps this off the toast's longer summary line.
  await expect(card.getByText("2 duplicates skipped", { exact: true })).toBeVisible();

  // …and a single duplicate reads in the singular.
  duplicates = 1;
  await card.getByRole("button", { name: "Import Customer Payments" }).click();
  await expect(card.getByText("1 duplicate skipped", { exact: true })).toBeVisible();
});
