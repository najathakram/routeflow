/**
 * F25 — calendar-date correctness on the web dashboard (T-B59 / T-B91, deploy-only).
 *
 * REG-B59 — Edit Route Run pre-filled `scheduledDate` a day early for any
 * operator west of UTC (a stored UTC-midnight instant read through the
 * browser's LOCAL `Date` getters), and saved a `scheduledDate` on every save
 * even when the date field was never touched, silently shifting the run's
 * day on an edit that only changed the driver.
 *
 * REG-B91 — a stored UTC-midnight `expiresAt` rendered one calendar day early
 * for a negative-UTC-offset viewer wherever the dashboard used a LOCAL
 * formatter instead of the shared `fmtCalendarDate` helper; the Customers →
 * Licenses tab is one of the nine sites.
 *
 * T1 (`readCalendarInput`) and T2 (`buildRunPatchBody`'s dirty-check) are
 * proven directly by
 * `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.test.ts`
 * against the extracted seam — that is the RED GATE. This spec is the
 * deployed-round-trip ANCHOR for the same two behaviors: it runs only
 * against the DEPLOYED site (never locally in this pipeline) and is
 * deliberately NOT part of the jest red gate, the same tier 23's settlement
 * spec and 27's cancelled-edit-banner spec occupy. `npx playwright test
 * --list` proving the `calendar-dates` project resolves is what this
 * package's build step verifies pre-merge; the deploy-signal e2e run
 * discharges B59/B91 themselves.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21/22/23). Tenant: the approved e2e-routeflow regression seed — never a
 * live client (enforced by helpers/constants.ts's assertTestTenant at import
 * time).
 *
 * Fixtures are fully self-provisioned (a throwaway route + run for flow 1, a
 * throwaway driver for flow 1's driver change, and a throwaway customer for
 * flow 2), following 23-run-settlement-note.spec.ts's idiom: `page.goto`
 * first so `operatorAccessToken`/`apiBase` can read the session, then
 * `Date.now()`-suffixed throwaway names. Nothing is cleaned up afterward —
 * the same residue tolerance 21/22/23 already take for a route/run/customer
 * fixture that reads as disposable in any admin view and moves no money.
 *
 * `timezoneId: "America/Los_Angeles"` on this spec's project (playwright
 * .config.ts) is what makes both bugs observable in the BROWSER: a UTC or
 * UTC-east viewer's local day never disagrees with the stored UTC-midnight
 * calendar day, so the regression would render invisible under the suite's
 * default (unset) timezone.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

// A UTC-midnight calendar date well clear of any DST transition, so this
// spec's outcome cannot depend on which side of a spring-forward/fall-back
// boundary the run happens to fall.
const SCHEDULED_DATE = "2026-06-10T00:00:00.000Z";
const EXPECTED_LICENSE_EXPIRY = "2026-11-01T00:00:00.000Z";

test.describe("Calendar-date correctness (F25 / B59, B91)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B59 editing only the driver leaves a run's scheduledDate unchanged", async ({
    page,
    request,
  }) => {
    await page.goto("/routes");
    const token = await operatorAccessToken(page);
    test.skip(!token, "No operator access token available in localStorage");
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());

    const suffix = Date.now();
    const routeName = `E2E B59 Run ${suffix}`;
    const driverEmail = `e2e_b59_driver_${suffix}@example.com`;

    // ── Fixture: a throwaway driver to switch the run onto, a route, and one
    // SCHEDULED run on it with a known, DST-clear scheduledDate.
    const driverRes = await request.post(`${api}/api/v1/drivers`, {
      headers,
      data: {
        contactName: `E2E B59 Driver ${suffix}`,
        email: driverEmail,
        username: `e2e_b59_driver_${suffix}`,
      },
    });
    expect(driverRes.ok(), `POST /drivers returned ${driverRes.status()}`).toBe(true);
    // DriversService.create() returns { driver, tempPassword } (mirrored by the web
    // client's useCreateDriver in apps/web/lib/api/drivers.ts) — the id is nested.
    const { driver }: { driver: { id: string } } = await driverRes.json();
    expect(driver?.id, "POST /drivers returned no driver id").toBeTruthy();

    const routeRes = await request.post(`${api}/api/v1/routes`, {
      headers,
      data: { name: routeName },
    });
    expect(routeRes.ok(), `POST /routes returned ${routeRes.status()}`).toBe(true);
    const route: { id: string } = await routeRes.json();
    expect(route?.id, "POST /routes response carried no id").toBeTruthy();

    const runRes = await request.post(`${api}/api/v1/route-runs`, {
      headers,
      data: { routeId: route.id, scheduledDate: SCHEDULED_DATE },
    });
    expect(runRes.ok(), `POST /route-runs returned ${runRes.status()}`).toBe(true);
    const run: { id: string; scheduledDate: string } = await runRes.json();
    expect(run?.id, "POST /route-runs response carried no id").toBeTruthy();

    // ── The edit: open Edit Route Run on the run detail page, change ONLY the
    // driver, save. The bug shipped scheduledDate on every save regardless of
    // whether the date field was dirtied.
    await page.goto(`/routes/${run.id}`);
    await expect(
      page.locator("#main-content").getByRole("heading", { name: routeName }),
    ).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const modalHeading = page.getByRole("heading", { name: "Edit Route Run", exact: true });
    await expect(modalHeading).toBeVisible({ timeout: 15_000 });
    const modal = modalHeading.locator("xpath=../..");

    // No `<label for>`/`id` association in EditRunModal, so getByLabel cannot
    // resolve it — Driver is the modal's only <select>.
    await modal.locator("select").selectOption({ label: `E2E B59 Driver ${suffix}` });
    await modal.getByRole("button", { name: "Save changes" }).click();
    await expect(modalHeading).not.toBeVisible({ timeout: 15_000 });

    // ── The proof: re-fetch the run from the server and assert scheduledDate
    // is byte-identical to what it was seeded with. A page that read the
    // stored date through LOCAL getters and re-derived it into the date input
    // would round-trip a DIFFERENT ISO string for any viewer west of UTC.
    const refetchRes = await request.get(`${api}/api/v1/route-runs/${run.id}`, { headers });
    expect(refetchRes.ok(), `GET /route-runs/:id returned ${refetchRes.status()}`).toBe(true);
    const refetched: { scheduledDate: string; driverId?: string | null } = await refetchRes.json();
    expect(refetched.scheduledDate).toBe(SCHEDULED_DATE);
    expect(refetched.driverId).toBe(driver.id);
  });

  test("REG-B91 the Licenses tab renders the stored calendar day, not one day early", async ({
    page,
    request,
  }) => {
    await page.goto("/routes");
    const token = await operatorAccessToken(page);
    test.skip(!token, "No operator access token available in localStorage");
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());

    // A category that requires a license — seeded regulated categories carry
    // this; if none exists on the target the fixture cannot be built and the
    // test skips rather than failing on an unrelated seed gap.
    const categoriesRes = await request.get(`${api}/api/v1/tracked-categories?active=true`, {
      headers,
    });
    expect(categoriesRes.ok(), `GET /tracked-categories returned ${categoriesRes.status()}`).toBe(
      true,
    );
    const categories: Array<{ id: string; requiresLicense?: boolean }> = await categoriesRes.json();
    const licenseCategory = categories.find((c) => c.requiresLicense);
    test.skip(!licenseCategory, "No tracked category requires a license on this tenant");

    const suffix = Date.now();
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers,
      data: {
        username: `e2e_b91_cust_${suffix}`,
        businessName: `E2E B91 Customer ${suffix}`,
        contactName: `E2E B91 Contact ${suffix}`,
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    // CustomersService.create() returns { customer, user, tempPassword } — the id is nested.
    const { customer } = (await customerRes.json()) as { customer: { id: string } };
    expect(customer?.id, "POST /customers response carried no id").toBeTruthy();

    const licenseNumber = `E2E-B91-${suffix}`;
    const authRes = await request.post(`${api}/api/v1/customers/${customer.id}/authorizations`, {
      headers,
      data: {
        trackedCategoryId: licenseCategory!.id,
        licenseNumber,
        expiresAt: EXPECTED_LICENSE_EXPIRY,
      },
    });
    expect(authRes.ok(), `POST /customers/:id/authorizations returned ${authRes.status()}`).toBe(
      true,
    );

    // ── The proof: the Licenses tab must render "Nov 1, 2026" — the calendar
    // day the UTC-midnight expiresAt actually encodes — not "Oct 31, 2026",
    // the day a LOCAL formatter renders for a viewer in America/Los_Angeles.
    await page.goto(`/customers/${customer.id}`);
    await page.getByRole("tab", { name: "Licenses" }).click();
    const row = page.locator("p", { hasText: licenseNumber });
    await expect(row).toContainText("Nov 1, 2026", { timeout: 15_000 });
    await expect(row).not.toContainText("Oct 31, 2026");
  });
});
