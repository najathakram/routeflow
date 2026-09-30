/**
 * F09 — apply a customer advance to an invoice from web (B13).
 *
 * REG-B13: web had no way to spend a customer's advance-payment wallet
 * balance against an invoice — only mobile could (ApplyAdvanceSheet,
 * apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx). The hook
 * (`useApplyAdvanceToInvoice`, apps/web/lib/api/invoices.ts) already existed
 * with zero callers; this spec proves the new UI (ApplyAdvanceModal, wired
 * into the invoice detail page's "Record Payment" dropdown) actually spends
 * the wallet: the invoice's balance drops by the applied amount, a payment
 * row with method ADVANCE appears, and the customer's advance-payments
 * endpoint reflects the decremented balance.
 *
 * T2, proven-pending-deploy (test-plan.md pattern: 21-destructive-guards /
 * 22-payment-truth / 28-credit-note-wallet). The server side is already
 * T1-proven by apps/api/src/customers/customers.service.spec.ts
 * (applyAdvancePaymentToInvoice predates this batch); this spec is the UI
 * wiring's own proof.
 *
 * Role: OPERATOR. Tenant: the approved e2e-routeflow regression seed (never
 * a live client — assertTestTenant at import time via helpers/constants.ts).
 * Fixtures are fully self-provisioned and throwaway (`E2E B13 …` customer +
 * invoice), left behind as harmless residue — the same tolerance
 * 21/22/24/27/28 already take.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Apply advance to invoice (F09 / B13)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B13: web invoice detail applies a customer advance and the balance due drops by the applied amount", async ({
    page,
    request,
  }) => {
    await page.goto("/invoices");
    await expect(page.getByRole("button", { name: "New Invoice" })).toBeVisible({
      timeout: 15_000,
    });

    const token = await operatorAccessToken(page);
    test.skip(!token, "No operator access token available in localStorage");
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());

    // ── Fixture: a throwaway customer + an invoice big enough that a partial
    // advance leaves it PARTIAL rather than fully PAID (the assertion below
    // needs both a live balance and a live wallet row afterward).
    const suffix = Date.now();
    const businessName = `E2E B13 Apply Advance ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers,
      data: {
        username: `e2e_b13_${suffix}`,
        businessName,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const invoiceRes = await request.post(`${api}/api/v1/invoices`, {
      headers,
      data: {
        customerId: customer.id,
        items: [{ description: "E2E B13 line", qty: 1, unitPrice: 100 }],
      },
    });
    expect(invoiceRes.ok(), `POST /invoices returned ${invoiceRes.status()}`).toBe(true);
    const invoice: { id: string; invoiceNumber: string } = await invoiceRes.json();

    // DRAFT invoices are excluded from CREDIT_NOT_APPLICABLE too, but the UI
    // gate (canRecordPayment, matched deliberately by the new "Apply Advance"
    // item) only offers the action once an invoice is actually issued.
    const sendRes = await request.post(`${api}/api/v1/invoices/${invoice.id}/send`, { headers });
    expect(sendRes.ok(), `POST /invoices/:id/send returned ${sendRes.status()}`).toBe(true);

    // A wallet balance smaller than the invoice total (100), so applying it
    // leaves the invoice PARTIAL — proof the applied amount, not the whole
    // invoice, moved.
    const advanceRes = await request.post(
      `${api}/api/v1/customers/${customer.id}/advance-payments`,
      {
        headers,
        data: { amount: 40, method: "CASH" },
      },
    );
    expect(
      advanceRes.ok(),
      `POST /customers/:id/advance-payments returned ${advanceRes.status()}`,
    ).toBe(true);
    const advance: { id: string; balance: number } = await advanceRes.json();
    expect(advance?.id, "POST /advance-payments response carried no id").toBeTruthy();

    // ── Drive the UI.
    await page.goto(`/invoices/${invoice.id}`);
    await expect(
      page.locator("#main-content").getByRole("heading", { name: invoice.invoiceNumber }),
    ).toBeVisible({ timeout: 15_000 });

    // Scoped by testid, not accessible name: the invoice detail page also has a
    // sidebar shortcut button AND the (always-mounted) payment modal's own submit
    // button both labeled "Record Payment" — `getByRole("button", {name:...})`
    // resolves to all three. The dropdown's items are plain <button>s (no
    // role="menuitem" — this hand-rolled DropdownMenu doesn't set one), so the
    // second click is a button lookup too.
    await page.getByTestId("record-payment-trigger").click();
    await page.getByRole("button", { name: "Apply Advance" }).click();

    await expect(page.getByRole("dialog", { name: "Apply advance" })).toBeVisible({
      timeout: 10_000,
    });
    const walletRow = page.getByRole("button", { name: /\$40\.00/ });
    await expect(walletRow).toBeVisible({ timeout: 10_000 });

    // The confirmation step is a native window.confirm — accept it.
    page.once("dialog", (d) => d.accept());
    await walletRow.click();

    await expect(page.getByText("Advance applied")).toBeVisible({ timeout: 10_000 });

    // ── Server-side truth: the payment landed, the wallet emptied, the
    // invoice balance dropped by exactly the applied amount.
    const invoiceAfterRes = await request.get(`${api}/api/v1/invoices/${invoice.id}`, { headers });
    expect(invoiceAfterRes.ok()).toBe(true);
    const invoiceAfter: {
      status: string;
      balanceDue: number;
      payments: { method: string; amount: number; reference?: string }[];
    } = await invoiceAfterRes.json();
    expect(invoiceAfter.status).toBe("PARTIAL");
    expect(Number(invoiceAfter.balanceDue)).toBeCloseTo(60, 2);
    const advancePayment = invoiceAfter.payments.find((p) => p.method === "ADVANCE");
    expect(advancePayment, "no ADVANCE payment row on the invoice").toBeTruthy();
    expect(Number(advancePayment!.amount)).toBeCloseTo(40, 2);
    expect(advancePayment!.reference ?? "").toMatch(/^AP-/);

    const walletAfterRes = await request.get(
      `${api}/api/v1/customers/${customer.id}/advance-payments`,
      { headers },
    );
    expect(walletAfterRes.ok()).toBe(true);
    const walletAfter: { id: string; balance: number }[] = await walletAfterRes.json();
    const spent = walletAfter.find((ap) => ap.id === advance.id);
    expect(Number(spent?.balance ?? -1)).toBeCloseTo(0, 2);
  });
});
