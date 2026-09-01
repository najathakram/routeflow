/**
 * F17 · Migration hub connector gate (B08, spec 25). READ-ONLY: GETs and
 * renders only — Start migration is NEVER clicked, so no migration job is
 * ever created (Zoho/QuickBooks have no connector wired up, and clicking
 * Start on a CSV/PAPER-connected source would actually start one).
 *
 * REG-B08: pre-fix, the Start button on /settings/migration is enabled for
 * every source — including Zoho Books and QuickBooks, which the source list
 * itself labels "connector coming soon" and which carry no OAuth wiring —
 * so selecting one and pressing Start throws instead of starting anything.
 * The fix disables Start (and relabels it "Connector coming soon") whenever
 * the selected source's `connected` flag is false; CSV/PAPER stay enabled
 * and keep saying "Start migration".
 *
 * Deliberately NO build-age self-skip. On this page a build that PREDATES the
 * fix and a build that has REGRESSED are indistinguishable — both leave Zoho
 * enabled and reading "Start migration" — so a skip keyed on that state would
 * swallow the exact regression this spec exists to catch and report it as
 * SKIPPED instead of FAILED. 12-search-back-nav.spec.ts can self-skip because
 * it has a signal (a `?search=` URL param) SEPARATE from what it asserts;
 * this page has no such signal, so the button state is asserted, not probed.
 * Staleness is handled one layer up instead: ci.yml's "Wait for the deployed
 * app to match this commit" gate FAILS the job rather than continuing unless
 * the deployed web build is code-identical to the commit under test.
 *
 * Role: OPERATOR (storage state from the "migration-hub-gate" project, mirroring
 * 19-compliance-pack-gate.spec.ts / 20-trip-builder-gate.spec.ts). Runs against
 * the DEPLOYED build (T2, proven-pending-deploy per the build plan) — red until
 * the PR deploys, by design; Playwright is not part of the pre-merge red gate.
 */
import { test, expect, type Page } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

/** A source tile button, matched on its label (the button's other text is the
 * "coming soon" / "exports from any system" description, which never collides
 * with another tile's label). */
function sourceTile(page: Page, label: string) {
  return page.getByRole("button", { name: new RegExp(label, "i") });
}

/** The single Start-migration / Connector-coming-soon action button — never
 * clicked by this spec, only ever read. */
function startButton(page: Page) {
  return page.getByRole("button", { name: /^(Start migration|Starting…|Connector coming soon)$/ });
}

/**
 * Selects a source tile and reads back the Start button's disabled state and
 * label for that source — the two things B08 governs. Reads only; the caller
 * does the asserting.
 */
async function selectAndReadGate(
  page: Page,
  label: string,
): Promise<{ disabled: boolean; text: string | null }> {
  await sourceTile(page, label).click();
  const btn = startButton(page);
  await expect(btn).toBeVisible({ timeout: 15_000 });
  const disabled = await btn.isDisabled();
  const text = (await btn.textContent())?.trim() ?? null;
  return { disabled, text };
}

test("REG-B08 migration hub: unconnected sources disable Start with 'Connector coming soon'; CSV keeps it enabled", async ({
  page,
}) => {
  await page.goto("/dashboard");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  // Confirm the session actually resolves before spending the rest of the
  // test on a page that will otherwise just bounce to /login.
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  test.skip(!res.ok(), `session token did not authenticate (${res.status()})`);

  await page.goto("/settings/migration");
  await expect(page.getByRole("heading", { name: "Move to RouteFlow" })).toBeVisible({
    timeout: 15_000,
  });

  // ── Zoho Books: no connector exists yet — Start must be disabled and say so.
  const zoho = await selectAndReadGate(page, "Zoho Books");
  expect(zoho.disabled, "Start button should be disabled with Zoho Books selected").toBe(true);
  expect(zoho.text).toBe("Connector coming soon");

  // ── QuickBooks: same story, no connector wired up either.
  const quickbooks = await selectAndReadGate(page, "QuickBooks");
  expect(quickbooks.disabled, "Start button should be disabled with QuickBooks selected").toBe(
    true,
  );
  expect(quickbooks.text).toBe("Connector coming soon");

  // ── CSV files: the working, connected path — Start re-enables and reverts
  // to its normal label. Assert-visibility-only: it is never clicked, so no
  // migration job is created by this spec.
  const csv = await selectAndReadGate(page, "CSV files");
  expect(csv.disabled, "Start button should re-enable once CSV files is selected").toBe(false);
  expect(csv.text).toBe("Start migration");
});
