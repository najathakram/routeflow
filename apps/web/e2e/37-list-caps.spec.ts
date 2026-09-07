/**
 * F16 — list caps / silent-truncation regressions (T8, test-plan.md).
 *
 * Proves the web leg of four F16 rows against the DEPLOYED build. Each server
 * half (REG-B12, REG-B80, REG-B144, REG-B110) is separately T1/T3/T4-proven
 * pre-merge by the apps/api jest specs in this same batch; this spec is the
 * T2 leg for the ones that have a web surface.
 *
 * (a) REG-B12 — the invoices page must derive its KPI tiles from a dedicated
 *     `/invoices/kpi-summary` read, not `useInvoices({ limit: 999 })` (which
 *     silently drops any tenant with >999 invoices). "Total Outstanding" is
 *     asserted against the SAME endpoint's own `totalOutstanding`, read
 *     directly via `request.get` (API oracle, L-086) rather than recomputed
 *     client-side.
 * (b) REG-B80 — the payment receipt page (`/finance/payments/[id]`) must
 *     fetch its payment by id (`GET /invoices/payments/:id`, `usePaymentDetail`)
 *     rather than paging through `useInvoicePayments({ limit: 200 })` and
 *     searching client-side — a payment past the 200th most-recent 404s today.
 * (c) REG-B144 — the orders list's customer-search box must be sent to the
 *     server as `search=`, not filtered client-side against only the current
 *     page's rows: a 25th match on a later page is invisible to a client
 *     filter that only ever sees page 1, and the pager was hidden outright
 *     while a search was active.
 * (d) REG-B110 — the customer detail page's Profile-tab "Open Balance" stat
 *     card (the customer's overview/landing tab) and the Invoices-tab
 *     "Outstanding" summary card must agree with EACH OTHER and with the
 *     statement endpoint's own `outstandingAmount`. Today they read TWO
 *     different sources — the Profile card reads `useCustomerStatement`
 *     (server-side, credit/advance-aware) while the Invoices-tab card
 *     recomputes its own total client-side from whatever page of
 *     `invoicesData` happens to be loaded — so they can disagree once either
 *     input is capped or the statement basis changes (REG-B110's DRAFT-count
 *     and truncation fixes).
 *
 * NEVER run this spec locally (test-plan.md, T8) — it targets the DEPLOYED
 * site only and its `list-caps` Playwright project entry is wired by the
 * batch orchestrator, not this file. Expected red until F16 ships; the
 * `/invoices/kpi-summary` endpoint and `usePaymentDetail` wiring do not exist
 * on the pre-fix build, so (a)/(b) 404 or time out until then.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21-destructive-guards / 22-payment-truth). Tenant: the approved
 * e2e-routeflow regression seed (assertTestTenant, helpers/constants.ts).
 * Every fixture created here (`E2E B144 …` customer + 25 orders, one
 * throwaway invoice + payment) is fully self-provisioned and left behind —
 * the same residue tolerance 21/22/24's own throwaway fixtures already take.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** Mirrors apps/web/lib/formatting.ts `fmt` — USD with a thousands separator. */
function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

type Headers = { authorization: string; "x-tenant-slug": string };

/**
 * Bearer + tenant headers for a direct API call, or null when unauthenticated —
 * the same shape 29-returns-lifecycle.spec.ts uses.
 *
 * `operatorAccessToken` reads the token out of the PAGE's localStorage, which
 * is per-ORIGIN: a fresh `page` sits on `about:blank`, whose storage is a
 * different (opaque) origin from the app's, so the operator storageState's
 * token is simply not there yet. Every caller must therefore navigate into the
 * app FIRST — `openApp()` below — exactly as 22-payment-truth and
 * 29-returns-lifecycle do before their own token reads. Reading before the
 * first navigation is what failed REG-B80/B144/B110 with "carried no access
 * token" while REG-B12 (which never reads a token) passed beside them.
 */
async function apiHeaders(page: Page): Promise<Headers | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

/**
 * Land on an app origin with the session applied, so `apiHeaders` can read the
 * token. `/invoices` + its "New Invoice" toolbar button is the hydration signal
 * REG-B12 above and 22-payment-truth both already rely on.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto("/invoices");
  await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * A stat tile's value cell — the invoices page's StatTile (label/value are
 * sibling <span>s) and the customer page's StatCard/Card idiom (sibling <p>s)
 * both put the label in a leaf node with nothing else in it, so an exact
 * match can't also match its containing tile — walk one sibling over to reach
 * the value, same helper shape as 22-payment-truth's `awaitingConfirmationValue`.
 */
function statTileValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");
}

test.describe("List caps / silent truncation (F16 / T8)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B12 kpi-summary replaces the limit=999 read and Total Outstanding matches the API", async ({
    page,
  }) => {
    const kpiRequests: string[] = [];
    const cappedInvoiceRequests: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") return;
      const url = r.url();
      if (/\/invoices\/kpi-summary\b/.test(url)) kpiRequests.push(url);
      // The bug: the KPI tiles used to be derived from this fetch-everything
      // read, which silently drops any tenant carrying more than 999
      // invoices. The fix must stop issuing it.
      if (/\/invoices\?.*\blimit=999\b/.test(url)) cappedInvoiceRequests.push(url);
    });

    const kpiResponse = page.waitForResponse(
      (r) => r.request().method() === "GET" && /\/invoices\/kpi-summary\b/.test(r.url()),
      { timeout: 30_000 },
    );
    await page.goto("/invoices");
    await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
      timeout: 15_000,
    });
    const kpiRes = await kpiResponse;
    expect(kpiRes.ok(), `GET ${kpiRes.url()} returned ${kpiRes.status()}`).toBe(true);

    expect(
      kpiRequests.length,
      "expected a GET /invoices/kpi-summary request, saw none",
    ).toBeGreaterThan(0);
    expect(
      cappedInvoiceRequests,
      `PaymentSummaryBar must not still fetch-all via limit=999 (saw ${cappedInvoiceRequests.join(", ")})`,
    ).toEqual([]);

    // API oracle (L-086): read the SAME endpoint directly rather than
    // recomputing totalOutstanding client-side, so this proves the rendered
    // tile agrees with the server's own figure.
    const kpiBody: { totalOutstanding: number } = await kpiRes.json();
    expect(
      typeof kpiBody.totalOutstanding,
      "kpi-summary response carried no totalOutstanding",
    ).toBe("number");

    const tile = statTileValue(page, "Total Outstanding");
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await expect(tile).toHaveText(fmtMoney(kpiBody.totalOutstanding), { timeout: 15_000 });
  });

  test("REG-B80 payment receipt fetches by id instead of paging useInvoicePayments(limit:200)", async ({
    page,
    request,
  }) => {
    await openApp(page);
    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());

    // Self-provisioned fixture: a throwaway customer + invoice + payment, so
    // this test never depends on whether the tenant's newest payment happens
    // to already sit within the first 200 rows useInvoicePayments would page.
    const suffix = Date.now();
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b80_${suffix}`,
        businessName: `E2E B80 Payment Detail ${suffix}`,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const invoiceRes = await request.post(`${api}/api/v1/invoices`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        items: [{ description: "E2E B80 line", qty: 1, unitPrice: 4200 }],
      },
    });
    expect(invoiceRes.ok(), `POST /invoices returned ${invoiceRes.status()}`).toBe(true);
    const invoice: { id: string } = await invoiceRes.json();

    const paymentRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/payments`, {
      headers: headers!,
      data: { amount: 4200, method: "CASH", status: "PAID" },
    });
    expect(paymentRes.ok(), `POST /invoices/:id/payments returned ${paymentRes.status()}`).toBe(
      true,
    );
    const recorded: { createdPaymentId: string } = await paymentRes.json();
    expect(
      recorded.createdPaymentId,
      "recordPayment response carried no createdPaymentId",
    ).toBeTruthy();

    const detailRes = await request.get(
      `${api}/api/v1/invoices/payments/${recorded.createdPaymentId}`,
      {
        headers: headers!,
      },
    );
    expect(detailRes.ok(), `GET /invoices/payments/:id returned ${detailRes.status()}`).toBe(true);
    const paymentDetail: { paymentNumber: string } = await detailRes.json();
    expect(paymentDetail.paymentNumber, "payment detail carried no paymentNumber").toBeTruthy();

    const byIdRequests: string[] = [];
    const cappedListRequests: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") return;
      const url = r.url();
      if (new RegExp(`/invoices/payments/${recorded.createdPaymentId}\\b`).test(url)) {
        byIdRequests.push(url);
      }
      if (/\/invoices\/payments\?.*\blimit=200\b/.test(url)) cappedListRequests.push(url);
    });

    await page.goto(`/finance/payments/${recorded.createdPaymentId}`);
    // "Payment not found." is what the buggy page renders once the id falls
    // outside the 200-row page it fetched — this must not appear once the
    // page is fetching by id instead.
    await expect(page.getByText(paymentDetail.paymentNumber)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Payment not found.")).toHaveCount(0);

    expect(
      byIdRequests.length,
      `expected a GET /invoices/payments/${recorded.createdPaymentId} request, saw none`,
    ).toBeGreaterThan(0);
    expect(
      cappedListRequests,
      `payment receipt must not fetch via useInvoicePayments(limit:200) (saw ${cappedListRequests.join(", ")})`,
    ).toEqual([]);
  });

  test("REG-B144 orders search is sent server-side and the pager stays visible with an active search", async ({
    page,
    request,
  }) => {
    await openApp(page);
    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());

    const suffix = String(Date.now());
    const businessName = `E2E B144 ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b144_${suffix}`,
        businessName,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    // 25 orders — one more than the default page size (20) — so a match on
    // page 2 is only reachable if the search actually narrowed the SERVER
    // query rather than only ever filtering whatever the first page happened
    // to already hold.
    for (let i = 0; i < 25; i++) {
      const orderRes = await request.post(`${api}/api/v1/orders`, {
        headers: headers!,
        data: {
          customerId: customer.id,
          status: "PENDING",
          items: [{ name: `E2E B144 item ${i}`, qty: 1, unitPrice: 10 }],
        },
      });
      expect(orderRes.ok(), `POST /orders (#${i}) returned ${orderRes.status()}`).toBe(true);
    }

    const searchRequests: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") return;
      const url = r.url();
      if (/\/orders\?/.test(url) && new RegExp(`[?&]search=${suffix}\\b`).test(url)) {
        searchRequests.push(url);
      }
    });

    await page.goto("/orders");
    const searchBox = page.getByPlaceholder("Search customer or order #…");
    await expect(searchBox).toBeVisible({ timeout: 15_000 });
    await searchBox.fill(suffix);

    await expect
      .poll(() => searchRequests.length, {
        timeout: 15_000,
        message: `expected a GET /orders?…search=${suffix} request, saw none`,
      })
      .toBeGreaterThan(0);

    const nextPageButton = page.getByRole("button", { name: "Next page" });
    await expect(nextPageButton).toBeVisible({ timeout: 15_000 });
    await expect(nextPageButton).toBeEnabled();
    await nextPageButton.click();

    await expect(page.getByText(businessName).first()).toBeVisible({ timeout: 15_000 });
  });

  test("REG-B110 customer Outstanding tiles agree with each other and the statement endpoint", async ({
    page,
    request,
  }) => {
    await openApp(page);
    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());

    const suffix = Date.now();
    const businessName = `E2E B110 Statement Parity ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b110_${suffix}`,
        businessName,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const invoiceRes = await request.post(`${api}/api/v1/invoices`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        items: [{ description: "E2E B110 line", qty: 1, unitPrice: 250 }],
      },
    });
    expect(invoiceRes.ok(), `POST /invoices returned ${invoiceRes.status()}`).toBe(true);
    const invoice: { id: string } = await invoiceRes.json();
    expect(invoice?.id, "POST /invoices response carried no invoice.id").toBeTruthy();

    // M2: a freshly-created invoice is DRAFT and DRAFT is excluded from
    // "outstanding" — issue it through the same API path the web's Send
    // button uses (POST :id/send, never a direct DB write) so the fixture
    // actually contributes to outstandingAmount and the test isn't a $0.00
    // == $0.00 tautology.
    const sendRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/send`, {
      headers: headers!,
    });
    expect(sendRes.ok(), `POST /invoices/:id/send returned ${sendRes.status()}`).toBe(true);

    // API oracle: the statement endpoint the customer detail page's
    // useCustomerStatement query itself reads.
    const statementRes = await request.get(`${api}/api/v1/customers/${customer.id}/statement`, {
      headers: headers!,
    });
    expect(
      statementRes.ok(),
      `GET /customers/:id/statement returned ${statementRes.status()}`,
    ).toBe(true);
    const statement: { outstandingAmount: number } = await statementRes.json();
    expect(
      typeof statement.outstandingAmount,
      "statement response carried no outstandingAmount",
    ).toBe("number");
    // Vacuity guard: without this, a $0.00 == $0.00 == $0.00 tautology would
    // pass even if the fixture never actually became outstanding.
    expect(statement.outstandingAmount).toBeGreaterThan(0);
    expect(statement.outstandingAmount).toBe(250);
    const expected = fmtMoney(statement.outstandingAmount);

    await page.goto(`/customers/${customer.id}`);
    await expect(page.getByText(businessName).first()).toBeVisible({ timeout: 15_000 });

    // Profile tab (the default/landing tab) — StatCard "Open Balance", fed by
    // useCustomerStatement.
    const profileTile = statTileValue(page, "Open Balance").first();
    await expect(profileTile).toBeVisible({ timeout: 15_000 });
    await expect(profileTile).toHaveText(expected, { timeout: 15_000 });

    // Invoices tab — the summary card literally labelled "Outstanding".
    const invoicesTab = page.getByRole("tab", { name: /Invoices/i });
    await invoicesTab.click();
    const invoicesTabOutstanding = statTileValue(page, "Outstanding").first();
    await expect(invoicesTabOutstanding).toBeVisible({ timeout: 15_000 });
    await expect(invoicesTabOutstanding).toHaveText(expected, { timeout: 15_000 });
  });
});
