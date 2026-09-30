/**
 * F12 — B161 web leg: dispatch modal warns about missed delivery windows
 * (bug-test-plan.md T4; REG-B161).
 *
 * REG-B147 / REG-B161 / REG-B177 (cause-ruling.md) fix the route optimizer so
 * it consults each stop's delivery window against the real departure clock on
 * every solver branch (Google cost-matrix, ORS, haversine fallback) and
 * reports `OptimizeResult.windowViolations` when no window-feasible order
 * exists. T1–T3 prove the server half directly in `apps/api` (jest, mocked
 * fetch, deterministic haversine matrix). This spec is the T2/T4 web leg: the
 * template page's Optimize toast must NAME the stop(s) that miss their
 * window, and BOTH dispatch modals (`templates/[id]/page.tsx` here;
 * `routes/page.tsx`'s duplicate is a separate call site the harness notes
 * flag but this spec does not reach) must show a late-stop warning and
 * refuse to enable "Dispatch" until the operator explicitly acknowledges it.
 *
 * NOT part of the local red gate (`redGate.commands` only runs the apps/api
 * jest lane) — this project has no dependency on it and is a project entry
 * only, discharged against the DEPLOYED site once F12 ships (same
 * pending-deploy convention as 22/23/24/25/26/27/30). It is expected red
 * today: neither the toast nor the Dispatch modal say anything about a
 * missed window, and the modal's "Dispatch" button carries no acknowledge
 * gate at all (always enabled).
 *
 * The modal's window check runs `windowsOnly` (no AI call, no metered usage)
 * and re-runs, debounced, on every Departure Time edit — so this spec also
 * pins that the warning tracks the clock being dispatched with, not the one
 * the modal opened at. Two states this spec deliberately does NOT reach: while
 * the check is in flight the modal shows "Checking delivery windows…" and
 * Dispatch is disabled; when the check FAILS (throttle, addon gate, 5xx) the
 * modal shows an inline "Couldn't check delivery windows" notice and leaves
 * Dispatch ENABLED — a failed check fails open, but visibly, so a throttled
 * tenant is never locked out of dispatching.
 *
 * Fixtures are fully self-provisioned via the API: a throwaway `E2E B161 …`
 * route template with a real depot (raw depotLat/depotLng — no geocoding
 * needed for that field) and two throwaway customers, each carrying one real,
 * geocodable address (POST /customers geocodes addresses synchronously before
 * its transaction opens — customers.service.ts create() — so lat/lng are
 * already resolved by the time GET /customers/:id is read back). One
 * customer's `deliveryWindowStart/End` is set to "00:00"–"00:01" — a window
 * that has already closed before ANY plausible route departure time, so the
 * persisted order misses it regardless of which solver branch answers on the
 * deployed site (Google, ORS, or the haversine fallback) and regardless of
 * stop order. Nothing is cleaned up afterward: a throwaway route + two
 * throwaway customers are the same disposable residue 21/22/23's own fixtures
 * already leave on the shared seed tenant.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21/22/23/24). Tenant: the approved e2e-routeflow regression seed — never
 * a live client (enforced by helpers/constants.ts's assertTestTenant at
 * import time).
 *
 * WITHOUT ITS `playwright.config.ts` PROJECT ENTRY THIS SPEC NEVER RUNS — see
 * 08-create-order-escape's header for the precedent where exactly that
 * happened and a spec sat dead.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

test.describe("Route delivery-window dispatch warning (F12 / B161)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B161 the Optimize toast names the stop(s) that miss their window, and Dispatch stays disabled until the late-stop warning is acknowledged (T2 / T4)", async ({
    page,
    request,
  }) => {
    // Hydration entry wait, same signal every other operator-role spec in
    // this suite uses before touching localStorage or the API.
    await page.goto("/routes");
    await expect(page.getByRole("button", { name: "New Route" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    // Hard failure, never a skip — a missing token is a stale operator
    // storageState or a setup project that did not run: an environment
    // fault, not a data condition (same convention as 24-order-edit-pricing).
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture 1: "OnTime" customer — a real, geocodable NYC address, no
    // delivery window. Exists purely so the route has 2 stops (Optimize is
    // disabled below 2 stops — see templates/[id]/page.tsx).
    const onTimeRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b161_ontime_${suffix}`,
        businessName: `E2E B161 OnTime ${suffix}`,
        contactName: "E2E Tester",
        addresses: [
          {
            label: "Main",
            line1: "20 W 34th St",
            city: "New York",
            state: "NY",
            zip: "10001",
          },
        ],
      },
    });
    // Hard failure, never a skip: username/businessName/contactName are
    // CreateCustomerDto's only required fields (24-order-edit-pricing's own
    // precedent for this same call), so a non-ok response is a broken
    // fixture or environment condition.
    expect(onTimeRes.ok(), `POST /customers (OnTime) returned ${onTimeRes.status()}`).toBe(true);
    const onTimeCustomer: { id: string } = (await onTimeRes.json()).customer;
    expect(onTimeCustomer?.id, "POST /customers (OnTime) carried no customer.id").toBeTruthy();

    // A deliberately WIDE window: open at any plausible tenant default
    // departure (so this stop is on time for the optimize toast and the
    // modal's first check — the count-of-1 oracle below depends on it), but
    // closed by the 23:30 departure the re-check step types in. Without a
    // window at all this stop could never be flagged, and the "the warning
    // tracks the departure time you actually edited" oracle would have nothing
    // to move.
    const onTimeWindowRes = await request.patch(`${api}/api/v1/customers/${onTimeCustomer.id}`, {
      headers: headers!,
      data: { deliveryWindowStart: "05:00", deliveryWindowEnd: "22:00" },
    });
    expect(
      onTimeWindowRes.ok(),
      `PATCH /customers/:id (OnTime delivery window) returned ${onTimeWindowRes.status()}`,
    ).toBe(true);

    // ── Fixture 2: "Late" customer — a distinct real NYC address, plus a
    // delivery window ("00:00"-"00:01") that has already closed before any
    // plausible route departure time. This guarantees the persisted order
    // misses the window regardless of which solver branch the deployed site
    // resolves to (Google cost-matrix / ORS / haversine fallback) and
    // regardless of stop order — the window is infeasible by construction,
    // not by a distance calculation this spec would otherwise have to
    // reproduce.
    const lateRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b161_late_${suffix}`,
        businessName: `E2E B161 Late ${suffix}`,
        contactName: "E2E Tester",
        addresses: [
          {
            label: "Main",
            line1: "89 E 42nd St",
            city: "New York",
            state: "NY",
            zip: "10017",
          },
        ],
      },
    });
    expect(lateRes.ok(), `POST /customers (Late) returned ${lateRes.status()}`).toBe(true);
    const lateCustomer: { id: string } = (await lateRes.json()).customer;
    expect(lateCustomer?.id, "POST /customers (Late) carried no customer.id").toBeTruthy();

    const windowRes = await request.patch(`${api}/api/v1/customers/${lateCustomer.id}`, {
      headers: headers!,
      data: { deliveryWindowStart: "00:00", deliveryWindowEnd: "00:01" },
    });
    expect(
      windowRes.ok(),
      `PATCH /customers/:id (delivery window) returned ${windowRes.status()}`,
    ).toBe(true);

    // Read both customers back — POST /customers's own response never
    // includes the created addresses (customers.service.ts create() returns
    // the bare `tx.customer.create` row; addresses are createMany'd after),
    // so their ids (needed for the route-stop calls below) only exist on the
    // GET.
    const onTimeFullRes = await request.get(`${api}/api/v1/customers/${onTimeCustomer.id}`, {
      headers: headers!,
    });
    expect(
      onTimeFullRes.ok(),
      `GET /customers/:id (OnTime) returned ${onTimeFullRes.status()}`,
    ).toBe(true);
    const onTimeFull: { addresses: { id: string }[] } = await onTimeFullRes.json();
    const onTimeAddressId = onTimeFull.addresses?.[0]?.id;
    expect(onTimeAddressId, "OnTime customer carried no address id").toBeTruthy();

    const lateFullRes = await request.get(`${api}/api/v1/customers/${lateCustomer.id}`, {
      headers: headers!,
    });
    expect(lateFullRes.ok(), `GET /customers/:id (Late) returned ${lateFullRes.status()}`).toBe(
      true,
    );
    const lateFull: { addresses: { id: string }[] } = await lateFullRes.json();
    const lateAddressId = lateFull.addresses?.[0]?.id;
    expect(lateAddressId, "Late customer carried no address id").toBeTruthy();

    // ── Fixture 3: the route template — a real depot (raw lat/lng; POST
    // /routes accepts depotLat/depotLng directly, no geocoding needed for
    // that field) near both customer addresses.
    const routeName = `E2E B161 Windows ${suffix}`;
    const routeRes = await request.post(`${api}/api/v1/routes`, {
      headers: headers!,
      data: {
        name: routeName,
        depotLat: 40.7128,
        depotLng: -74.006,
        depotAddress: "1 Centre St, New York, NY 10007",
      },
    });
    expect(routeRes.ok(), `POST /routes returned ${routeRes.status()}`).toBe(true);
    const route: { id: string } = await routeRes.json();
    expect(route?.id, "POST /routes response carried no id").toBeTruthy();

    const addOnTimeStopRes = await request.post(`${api}/api/v1/routes/${route.id}/stops`, {
      headers: headers!,
      data: { customerId: onTimeCustomer.id, customerAddressId: onTimeAddressId },
    });
    expect(
      addOnTimeStopRes.ok(),
      `POST /routes/:id/stops (OnTime) returned ${addOnTimeStopRes.status()}`,
    ).toBe(true);

    const addLateStopRes = await request.post(`${api}/api/v1/routes/${route.id}/stops`, {
      headers: headers!,
      data: { customerId: lateCustomer.id, customerAddressId: lateAddressId },
    });
    expect(
      addLateStopRes.ok(),
      `POST /routes/:id/stops (Late) returned ${addLateStopRes.status()}`,
    ).toBe(true);

    // ── Open the template. Hydration wait: the inline route-name button
    // (page.tsx renders `route.name` as a clickable button before edit mode).
    await page.goto(`/routes/templates/${route.id}`);
    await expect(page.getByRole("button", { name: routeName })).toBeVisible({ timeout: 15_000 });

    const optimizeButton = page.getByRole("button", { name: /^Optimiz/ });
    await expect(optimizeButton).toBeEnabled({ timeout: 15_000 });
    await optimizeButton.click();

    // ── The toast half of the proof (T2/T4): the toast viewport is Radix's
    // role="region" labelled "Notifications"; each toast inside it is a
    // plain <li> (L-076 / 21-destructive-guards precedent) — scope through
    // it rather than a bare text lookup, which would double-match the
    // aria-live announcer mirror once one exists.
    const windowToast = page
      .getByRole("region", { name: /notifications/i })
      .getByRole("listitem")
      .filter({ hasText: /window/i })
      .first();
    await expect(
      windowToast,
      "REG-B161: the Optimize toast must name the stop(s) that miss their delivery window — today it only ever reports the reordered count",
    ).toBeVisible({ timeout: 20_000 });
    // Names the COUNT, not just the word "window" — exactly one stop (the
    // "Late" customer) is infeasible in this fixture.
    await expect(windowToast).toContainText(/\b1\b/);

    // ── The Dispatch-modal half of the proof (T4). Ad-hoc trips use a
    // different affordance (a hint, never a Dispatch button) — this route is
    // SCHEDULED (the default `kind` on POST /routes), so "Dispatch Run" is
    // the control under test.
    await page.getByRole("button", { name: "Dispatch Run" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const lateStopWarning = dialog.getByRole("alert").filter({ hasText: /window/i });
    await expect(
      lateStopWarning,
      "REG-B161: the Dispatch modal must warn about the stop that misses its delivery window — today it renders no such warning at all",
    ).toBeVisible({ timeout: 10_000 });

    const dispatchButton = dialog.getByRole("button", { name: "Dispatch", exact: true });
    await expect(
      dispatchButton,
      "REG-B161: Dispatch must stay disabled until the late-stop warning is explicitly acknowledged — today it is always enabled",
    ).toBeDisabled({ timeout: 5_000 });

    const acknowledgeCheckbox = dialog.getByRole("checkbox", { name: /outside their window/i });
    await expect(
      acknowledgeCheckbox,
      "REG-B161: the Dispatch modal must offer an explicit acknowledge control for the late-stop warning",
    ).toBeVisible({ timeout: 5_000 });
    await acknowledgeCheckbox.check();
    await expect(dispatchButton).toBeEnabled({ timeout: 5_000 });

    // ── The warning must describe the departure time being DISPATCHED, not
    // the one the modal happened to open with. Type a departure after BOTH
    // fixture windows have closed (Late's 00:01 and OnTime's 22:00): the
    // re-check must now list TWO stops — the previously on-time one included —
    // and the acknowledgement of the previous, one-stop warning must not carry
    // over. The count moving 1 → 2 is the load-bearing oracle: a warning still
    // computed at the opening clock stays at 1.
    const departureInput = dialog.locator('input[type="time"]');
    await departureInput.fill("23:30");

    await expect(
      lateStopWarning,
      "the late-stop warning must recompute against the edited Departure Time — both fixture windows have closed by 23:30",
    ).toContainText(/\b2\b/, { timeout: 20_000 });
    await expect(
      dispatchButton,
      "acknowledging a warning for one departure time must not carry over to another",
    ).toBeDisabled({ timeout: 5_000 });
    await acknowledgeCheckbox.check();
    await expect(dispatchButton).toBeEnabled({ timeout: 5_000 });

    // Never actually dispatched — the proof is the gate, not the run it
    // would create. Close the modal without dispatching.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
