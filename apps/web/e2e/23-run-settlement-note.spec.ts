/**
 * F05 — run settlement visibility on the web run detail page (T-B167 / R9 / R10).
 *
 * REG-B167 — a driver settles a run's cash at the end of the day and the
 * settlement text (expected vs counted, the signed variance, the reason) is
 * written to the run. Today the operator has nowhere to READ it: the web run
 * detail page (`/routes/[id]`) renders neither `settlementNote` nor
 * `settlementVariance` nor the legacy `run.notes` a pre-F05 mobile build
 * appended its settlement text to. Cash discrepancies therefore close invisibly
 * — which is the whole point of recording them.
 *
 * This spec proves the read surface for the case that matters most: a run that
 * is already **COMPLETED**. A card that only rendered while a run was open
 * would leave every historical run exactly as blind as before, so the
 * assertions below all run AFTER the run is closed.
 *
 * T2, proven-pending-deploy (test-plan.md): it runs against the DEPLOYED site,
 * never locally in this pipeline, and it is deliberately NOT part of the jest
 * red gate. It IS red against a pre-F05 build — no self-skip on a missing card,
 * unlike 09/11/12 — because "the card is absent" is precisely the regression
 * this spec exists to catch. `npx playwright test --list` proving the
 * `run-settlement` project resolves is what discharges R10 pre-merge; the
 * deploy-signal e2e run discharges B167 itself.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same as
 * 21-destructive-guards / 22-payment-truth). Tenant: the approved e2e-routeflow
 * regression seed — never a live client (enforced by helpers/constants.ts's
 * assertTestTenant at import time).
 *
 * Fixtures are fully self-provisioned (a route with NO stops, plus one run on
 * it, both named `E2E B167 …`) so the test never depends on whatever runs the
 * shared seed tenant already carries, and so the COMPLETED transition can't be
 * blocked by a pending stop it did not create. Nothing is cleaned up afterward:
 * a closed, stopless throwaway route/run reads as disposable in any admin view
 * and moves no money — the same residue tolerance 21/22 already take. No
 * at-door collection happens here, so this spec needs no `driver_payments`
 * addon and the run's server-expected cash is a known $0.00.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/**
 * Counted cash for the settlement. The run collected nothing, so the server's
 * own expected figure is $0.00 and the variance is a known, signed +25.75.
 * Deliberately not a round number: "25.75" cannot collide with a stop count, a
 * distance, an order total or any other figure the run page renders, so a
 * text-level assertion for it can only be satisfied by the variance itself.
 */
const COUNTED_CASH = 25.75;

test.describe("Run settlement visibility (F05 / B167)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B167 a COMPLETED run's detail page shows the settlement note, its signed variance, and the legacy run notes", async ({
    page,
    request,
  }) => {
    // A page load first: the operator JWT lives in the pre-authenticated
    // session's localStorage, and apiBase() derives the API origin from the
    // current web URL.
    await page.goto("/routes");
    const token = await operatorAccessToken(page);
    test.skip(!token, "No operator access token available in localStorage");
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());

    const suffix = Date.now();
    const routeName = `E2E B167 Settlement ${suffix}`;
    // Two distinct unique tokens so the two halves of R9 cannot satisfy each
    // other: a page that rendered ONLY the legacy notes, or ONLY the new
    // settlement note, fails on the other assertion instead of passing on a
    // shared string.
    const varianceReason = `E2E B167 reason ${suffix}`;
    const legacyNote = `E2E B167 legacy note ${suffix}`;

    // ── Fixture: a route with no stops, and one run on it. A stopless run is
    // what lets the COMPLETED transition below succeed unconditionally — a run
    // with a pending stop is refused by updateRunStatus's incomplete-stops
    // guard, which has nothing to do with what this spec proves.
    const routeRes = await request.post(`${api}/api/v1/routes`, {
      headers,
      data: { name: routeName },
    });
    // Hard failure, never a skip: `name` is CreateRouteDto's only required
    // field, so a non-ok response is a broken fixture or an environment
    // condition — skipping here would discharge REG-B167 on a run that never
    // reached a single assertion.
    expect(routeRes.ok(), `POST /routes returned ${routeRes.status()}`).toBe(true);
    const route: { id: string } = await routeRes.json();
    expect(route?.id, "POST /routes response carried no id").toBeTruthy();

    const runRes = await request.post(`${api}/api/v1/route-runs`, {
      headers,
      data: { routeId: route.id, scheduledDate: new Date().toISOString() },
    });
    expect(runRes.ok(), `POST /route-runs returned ${runRes.status()}`).toBe(true);
    const run: { id: string } = await runRes.json();
    expect(run?.id, "POST /route-runs response carried no id").toBeTruthy();

    // ── Legacy half of R9: settlement text that a PRE-F05 mobile build would
    // have appended to `run.notes` rather than to `settlementNote`. Every run
    // closed before this batch carries its settlement this way, so the card has
    // to surface it too or B167 stays open for all of history.
    const notesRes = await request.patch(`${api}/api/v1/route-runs/${run.id}`, {
      headers,
      data: { notes: legacyNote },
    });
    expect(notesRes.ok(), `PATCH /route-runs/:id (notes) returned ${notesRes.status()}`).toBe(true);

    // A run must be started before it can be settled (R6 accepts IN_PROGRESS
    // and COMPLETED, refuses CANCELLED).
    const startRes = await request.patch(`${api}/api/v1/route-runs/${run.id}/status`, {
      headers,
      data: { status: "IN_PROGRESS" },
    });
    expect(
      startRes.ok(),
      `PATCH /route-runs/:id/status IN_PROGRESS returned ${startRes.status()}`,
    ).toBe(true);

    // ── The settlement itself (R6). Nothing was collected, so the server's own
    // expected figure is $0.00 and counting $25.75 is a genuine over-variance
    // that REQUIRES a reason — exercising the reason path rather than the
    // trivial variance-0 one, so the note this page must render actually has
    // something in it worth reading.
    const settleRes = await request.post(`${api}/api/v1/route-runs/${run.id}/settlement`, {
      headers,
      data: { countedCash: COUNTED_CASH, varianceReason },
    });
    expect(settleRes.ok(), `POST /route-runs/:id/settlement returned ${settleRes.status()}`).toBe(
      true,
    );
    const settlement: { expectedCash?: number; countedCash?: number; variance?: number } =
      await settleRes.json();
    // The server owns the arithmetic — pinned here so a page assertion below
    // can never be satisfied by a variance the CLIENT supplied.
    expect(settlement.variance).toBeCloseTo(COUNTED_CASH, 2);

    // ── Close the run. Everything asserted after this point is asserted about a
    // COMPLETED run, which is the exact gap B167 names.
    const completeRes = await request.patch(`${api}/api/v1/route-runs/${run.id}/status`, {
      headers,
      data: { status: "COMPLETED" },
    });
    expect(
      completeRes.ok(),
      `PATCH /route-runs/:id/status COMPLETED returned ${completeRes.status()}`,
    ).toBe(true);

    // ── The proof: open the run detail page and read the Settlement card.
    await page.goto(`/routes/${run.id}`);
    // Hydration entry wait — the run page renders the route's name as its own
    // h1, scoped through #main-content (the dashboard shell's single content
    // region) the way 22-payment-truth scopes its invoice heading.
    await expect(
      page.locator("#main-content").getByRole("heading", { name: routeName }),
    ).toBeVisible({ timeout: 20_000 });

    const settlementHeading = page.getByRole("heading", { name: "Settlement" });
    await expect(settlementHeading).toBeVisible({ timeout: 15_000 });
    // Card renders its `title` as an <h3> sibling of the content that follows it
    // in the same wrapper div (packages/ui/src/web/Card.tsx) — the direct parent
    // of the heading is that wrapper.
    const settlementCard = settlementHeading.locator("xpath=..");

    // R9, half one: the server-formatted settlementNote, proven by the reason
    // token it carries. A card that rendered a placeholder, or the run's notes
    // in place of the note, fails here.
    await expect(settlementCard).toContainText(varianceReason, { timeout: 15_000 });

    // R9, half two: the SIGNED variance BADGE. The sign is the load-bearing
    // part — an absolute-value badge cannot tell an operator whether the driver
    // came back over or short, which is the only question a variance answers.
    // Scoped to the badge itself, NOT the card: the server-formatted note the
    // card also renders carries its own "Variance: +$25.75" line, so a
    // card-scoped assertion stays green with the badge deleted entirely and the
    // badge half of R9 would ship unproven. Tolerant of the currency symbol and
    // of whitespace between sign and amount, strict about the "+" being there.
    await expect(settlementCard.getByTestId("settlement-variance")).toHaveText(
      /\+\s*\$?\s*25\.75/,
      { timeout: 15_000 },
    );

    // R9, half three: the legacy `run.notes` text, so runs closed by a pre-F05
    // build are covered by the same card.
    await expect(settlementCard).toContainText(legacyNote, { timeout: 15_000 });
  });
});
