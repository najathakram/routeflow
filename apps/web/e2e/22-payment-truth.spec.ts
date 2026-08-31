/**
 * F03 — payment-status truth, web surface (P4).
 *
 * REG-B11 — a payment recorded with `status: "DRAFT"` is unconfirmed money:
 * the server excludes it from every CONFIRMED_PAYMENT sum (balanceDue, the
 * bookkeeping dashboards, the PDF, the email — invoices.service.ts's
 * CONFIRMED_PAYMENT predicate, this same batch's P1). The invoice detail
 * page's Payment History row must say so instead of rendering a DRAFT
 * payment identically to a confirmed one — this spec is that proof.
 *
 * T2, proven-pending-deploy (test-plan.md): this runs against the DEPLOYED
 * site, never locally in this pipeline — the server half of the predicate is
 * separately T1-proven pre-merge by apps/api/src/invoices/invoices.service.spec.ts
 * in the same batch. It is authored here alongside the UI it drives (build-plan
 * P4: "e2e spec authored in P4, not red-gated") because there is nothing to be
 * red against before a deploy exists to run it on.
 *
 * ⚠️ KNOWN GAP (flagged to the batch owner, not silently dropped): R2 also
 * calls for "a dashboard count of payments awaiting confirmation" on the
 * smallest sensible dashboard tile. This package's file-edit scope was
 * restricted to this spec plus the invoice-detail page only — the tile's home
 * (e.g. `apps/web/app/(dashboard)/dashboard/page.tsx` or the invoices list's
 * `PaymentSummaryBar`) was out of scope, so no such tile exists yet and this
 * spec does NOT assert one. Only the Payment History badge (this spec's one
 * test) is proven. See the P4 handoff notes for the follow-up.
 *
 * ⚠️ ALSO FLAGGED: this file has no matching entry in `playwright.config.ts`'s
 * `projects` array (also out of this package's file-edit scope). Every other
 * numbered spec needs one — see e.g. 08-create-order-escape's own header
 * ("The spec shipped without this project entry, so it NEVER ran.") — so
 * without that follow-up edit this spec is inert in CI despite existing on
 * disk. The needed entry mirrors "destructive-guards" (21): `dependencies:
 * ["setup"]`, `storageState: operator.json`.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21-destructive-guards). Tenant: the approved e2e-routeflow regression
 * seed (never a live client — enforced by helpers/constants.ts's
 * assertTestTenant at import time). The fixtures created here (a throwaway
 * customer + a standalone invoice, named `E2E B11 …`) are fully
 * self-provisioned and read as disposable in any admin view; nothing is
 * cleaned up afterward — an unpaid invoice with a draft payment on a
 * throwaway customer is harmless residue on a shared seed tenant, the same
 * tolerance 21-destructive-guards' own customer fixture takes.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Payment-status truth (F03 / P4)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B11 Payment History badges an unconfirmed DRAFT payment and leaves a confirmed PAID one unbadged", async ({
    page,
    request,
  }) => {
    await page.goto("/invoices");
    // Hydration entry wait — the same signal 21-destructive-guards waits on for
    // /products: a control the toolbar always renders once React has attached,
    // rather than a table row that may not exist on an otherwise-idle tenant.
    // "New Invoice" is a Button (onClick + router.push), not an anchor — role
    // "button", not "link".
    await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
      timeout: 15_000,
    });

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

    const paidRow = paymentHistoryCard.locator("li", { hasText: "$100.00" });
    await expect(paidRow).toBeVisible({ timeout: 10_000 });
    await expect(paidRow.getByText("Draft — unconfirmed")).toHaveCount(0);
  });
});
