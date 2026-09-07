/**
 * F03 — payment-status truth, web surface (P4).
 *
 * REG-B11 — a payment recorded with `status: "DRAFT"` is unconfirmed money:
 * the server excludes it from every CONFIRMED_PAYMENT sum (balanceDue, the
 * bookkeeping dashboards, the PDF, the email — invoices.service.ts's
 * CONFIRMED_PAYMENT predicate, this same batch's P1). The invoice detail
 * page's Payment History row must say so instead of rendering a DRAFT
 * payment identically to a confirmed one, its balance summary must stay on
 * that same CONFIRMED basis (a page that counted the DRAFT row would
 * contradict the badge it renders directly above it), AND the invoices list's
 * PaymentSummaryBar must surface a dashboard count of payments awaiting
 * confirmation (R2's other half) — this spec proves all three.
 *
 * T2, proven-pending-deploy (test-plan.md): this runs against the DEPLOYED
 * site, never locally in this pipeline — the server half of the predicate is
 * separately T1-proven pre-merge by apps/api/src/invoices/invoices.service.spec.ts
 * in the same batch. It is authored here alongside the UI it drives (build-plan
 * P4: "e2e spec authored in P4, not red-gated") because there is nothing to be
 * red against before a deploy exists to run it on.
 *
 * Its `playwright.config.ts` project entry (mirroring "destructive-guards"
 * (21): `dependencies: ["setup"]`, `storageState: operator.json`) is wired
 * separately by the batch orchestrator, not by this file.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21-destructive-guards). Tenant: the approved e2e-routeflow regression
 * seed (never a live client — enforced by helpers/constants.ts's
 * assertTestTenant at import time). The fixtures created here (a throwaway
 * customer + a standalone invoice, named `E2E B11 …`) are fully
 * self-provisioned and read as disposable in any admin view; nothing is
 * cleaned up afterward — an unpaid invoice with a draft payment on a
 * throwaway customer is harmless residue on a shared seed tenant, the same
 * tolerance 21-destructive-guards' own customer fixture takes. That residue is
 * exactly why the "Awaiting Confirmation" tile — a TENANT-WIDE counter — is
 * asserted as a delta against a baseline read at the top of this test rather
 * than against an absolute floor: from the second run onward the tenant always
 * carries leftover DRAFT payments, so a `>= 1` oracle would be satisfied by
 * them no matter what the counter had regressed to counting.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/**
 * The "Awaiting Confirmation" tile's value cell. The tile's overline label is a
 * leaf <span> with nothing else in it, so an exact match can't also match its
 * containing tile (which additionally holds the value and the hint text) — walk
 * one sibling over to reach the value.
 */
function awaitingConfirmationValue(page: Page) {
  return page
    .getByText("Awaiting Confirmation", { exact: true })
    .locator("xpath=following-sibling::span[1]");
}

/**
 * The PaymentSummaryBar's own summary query (B12: `useInvoiceKpiSummary`,
 * `GET /invoices/kpi-summary`, replacing the old `useInvoices({ limit: 999 })`
 * fetch-all-then-reduce). Every tile is derived from it and the bar renders
 * zeros until it resolves, so a value read straight after hydration can
 * capture a transient 0 instead of the tenant's real count. Arm this BEFORE
 * navigating, await it after.
 */
function summaryBarQuery(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "GET" && /\/invoices\/kpi-summary\b/.test(r.url()) && r.ok(),
    { timeout: 30_000 },
  );
}

/**
 * The settled tile value. React repaints a tick after the query above resolves,
 * so accept a number only once two consecutive reads agree on it.
 */
async function readAwaitingCount(page: Page): Promise<number> {
  const value = awaitingConfirmationValue(page);
  await expect(value).toBeVisible({ timeout: 15_000 });
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const seen = Number((await value.textContent())?.trim());
        const agreed = Number.isInteger(seen) && seen === last;
        last = seen;
        return agreed;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return last;
}

test.describe("Payment-status truth (F03 / P4)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B11 Payment History badges an unconfirmed DRAFT payment, leaves a confirmed PAID one unbadged, and the invoices list counts it as awaiting confirmation", async ({
    page,
    request,
  }) => {
    // Armed before the navigation so the response can't land ahead of the
    // listener — the baseline read below depends on it having arrived.
    const barLoaded = summaryBarQuery(page);
    await page.goto("/invoices");
    // Hydration entry wait — the same signal 21-destructive-guards waits on for
    // /products: a control the toolbar always renders once React has attached,
    // rather than a table row that may not exist on an otherwise-idle tenant.
    // "New Invoice" is a Button (onClick + router.push), not an anchor — role
    // "button", not "link".
    await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
      timeout: 15_000,
    });
    await barLoaded;

    // ── Baseline for R2's count half, read BEFORE this run's fixture exists.
    // The tile counts DRAFT payments across the whole tenant and this spec
    // leaves its fixtures behind, so the only assertion that can fail for a
    // plausible regression is the movement this run's own fixture causes.
    const before = await readAwaitingCount(page);

    const token = await operatorAccessToken(page);
    test.skip(!token, "No operator access token available in localStorage");
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());

    // ── Fixture: a throwaway customer + a standalone invoice, self-provisioned
    // so this test never depends on whatever invoice/payment mix the shared
    // seed tenant already carries.
    const suffix = Date.now();
    const businessName = `E2E B11 Draft Payment ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers,
      data: {
        username: `e2e_b11_${suffix}`,
        businessName,
        contactName: "E2E Tester",
      },
    });
    // Hard failure, never a skip: username/businessName/contactName are
    // CreateCustomerDto's only required fields, so a non-ok response is a
    // broken fixture or an environment condition, not a data condition —
    // skipping would discharge REG-B11 on a run that never reached its
    // assertions (same reasoning 21-destructive-guards applies to its own
    // self-provisioned fixtures).
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    // POST /customers nests its result: { customer: {...}, ... } (verified
    // live 2026-08-31 by 21-destructive-guards' REG-B130 case).
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const invoiceRes = await request.post(`${api}/api/v1/invoices`, {
      headers,
      data: {
        customerId: customer.id,
        items: [{ description: "E2E B11 line", qty: 1, unitPrice: 1000 }],
      },
    });
    expect(invoiceRes.ok(), `POST /invoices returned ${invoiceRes.status()}`).toBe(true);
    const invoice: { id: string; invoiceNumber: string } = await invoiceRes.json();

    // An unconfirmed payment — an ACH transfer initiated but not yet cleared,
    // the real-world case the CONFIRMED_PAYMENT predicate exists for — plus a
    // confirmed PAID one at a distinct amount, so the assertion below proves
    // the badge is conditional on payment status rather than always rendered.
    const draftPaymentRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/payments`, {
      headers,
      data: { amount: 200, method: "ACH", status: "DRAFT" },
    });
    expect(
      draftPaymentRes.ok(),
      `POST /invoices/:id/payments (DRAFT) returned ${draftPaymentRes.status()}`,
    ).toBe(true);

    // A SECOND unconfirmed payment — a post-dated check — on the same invoice.
    // It is what makes the awaiting-confirmation delta asserted at the end of
    // this test discriminating: the fixture is deliberately asymmetric (one new
    // invoice · two DRAFT payments · one confirmed payment), so a counter that
    // counted confirmed payments, or counted invoices carrying a draft rather
    // than the draft payments themselves, moves by a different amount than a
    // correct one.
    const draft2PaymentRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/payments`, {
      headers,
      data: { amount: 300, method: "CHECK", status: "DRAFT" },
    });
    expect(
      draft2PaymentRes.ok(),
      `POST /invoices/:id/payments (2nd DRAFT) returned ${draft2PaymentRes.status()}`,
    ).toBe(true);

    const paidPaymentRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/payments`, {
      headers,
      data: { amount: 100, method: "CASH", status: "PAID" },
    });
    expect(
      paidPaymentRes.ok(),
      `POST /invoices/:id/payments (PAID) returned ${paidPaymentRes.status()}`,
    ).toBe(true);

    // ── The proof: open the invoice and read the Payment History card.
    await page.goto(`/invoices/${invoice.id}`);
    // Hydration entry wait — the invoice number renders as the page's own h1,
    // scoped through #main-content (the dashboard shell's single content
    // region) the way 21-destructive-guards scopes its product-name heading
    // wait, in case any other surface ever renders the same text.
    const heading = page
      .locator("#main-content")
      .getByRole("heading", { name: invoice.invoiceNumber });
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // Card renders its `title` as an <h3> sibling of the content that follows
    // it in the same wrapper div (packages/ui/src/web/Card.tsx) — the direct
    // parent of the "Payment History" heading is that wrapper.
    const paymentHistoryHeading = page.getByRole("heading", { name: "Payment History" });
    await expect(paymentHistoryHeading).toBeVisible({ timeout: 10_000 });
    const paymentHistoryCard = paymentHistoryHeading.locator("xpath=..");

    const draftRow = paymentHistoryCard.locator("li", { hasText: "$200.00" });
    await expect(draftRow).toBeVisible({ timeout: 10_000 });
    await expect(draftRow.getByText("Draft — unconfirmed")).toBeVisible({ timeout: 10_000 });

    const draft2Row = paymentHistoryCard.locator("li", { hasText: "$300.00" });
    await expect(draft2Row).toBeVisible({ timeout: 10_000 });
    await expect(draft2Row.getByText("Draft — unconfirmed")).toBeVisible({ timeout: 10_000 });

    const paidRow = paymentHistoryCard.locator("li", { hasText: "$100.00" });
    await expect(paidRow).toBeVisible({ timeout: 10_000 });
    await expect(paidRow.getByText("Draft — unconfirmed")).toHaveCount(0);

    // ── The same truth one card down: the balance summary is where this page
    // states how much money has actually been collected, so it must read the
    // server's CONFIRMED basis (findOne's paidAmount/balanceDue) — the $200 and
    // $300 DRAFT rows are not collected money. "Paid" therefore shows only the
    // $100 confirmed payment and "Balance Due" stays the invoice total minus
    // that $100, agreeing to the cent with the invoices list row, the PDF and
    // the reminder email. A page that summed every non-VOID payment here would
    // print $600 paid directly beneath badges saying $500 of it is not counted.
    // Asserted against the RENDERED invoice total rather than a hardcoded
    // $1000 so a tenant tax/shipping setting can't turn a truth regression into
    // a fixture-arithmetic failure.
    const summaryValue = (label: string) =>
      page
        .locator("dt", { hasText: new RegExp(`^${label}$`) })
        .locator("xpath=following-sibling::dd[1]");
    const readMoney = async (label: string) => {
      const text = (await summaryValue(label).textContent())?.trim() ?? "";
      const amount = Number(text.replace(/[^0-9.-]/g, ""));
      expect(
        Number.isFinite(amount),
        `Balance summary "${label}" rendered "${text}", expected a money amount`,
      ).toBe(true);
      return amount;
    };
    await expect(summaryValue("Balance Due")).toBeVisible({ timeout: 10_000 });
    const invoiceTotal = await readMoney("Invoice Total");
    expect(await readMoney("Paid")).toBeCloseTo(100, 2);
    expect(await readMoney("Balance Due")).toBeCloseTo(invoiceTotal - 100, 2);

    // ── The proof (R2's other half): the invoices list's PaymentSummaryBar
    // carries an "Awaiting Confirmation" stat tile counting DRAFT payments
    // across all invoices (StatTile, apps/web/app/(dashboard)/invoices/page.tsx).
    // A fresh navigation (not a client-side route change) so its own
    // useInvoices({ limit: 999 }) query refetches and picks up the DRAFT
    // payments just created above rather than serving a stale cache.
    await page.goto("/invoices");
    await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
      timeout: 15_000,
    });

    // Exactly +2 against the baseline read at the top of this test — the count
    // this run's own fixture added, which is the only movement a regression can
    // be caught by on a tenant that permanently carries leftover DRAFT payments.
    // Each plausible regression lands somewhere else: counting confirmed
    // payments, or counting invoices that carry a draft rather than the draft
    // payments themselves, both give +1; a counter that no longer sees the
    // invoice just created gives +0. Polled rather than read once, because the
    // bar's query resolves a tick after the page is interactive.
    await expect
      .poll(async () => (await awaitingConfirmationValue(page).textContent())?.trim(), {
        timeout: 20_000,
      })
      .toBe(String(before + 2));
  });
});
