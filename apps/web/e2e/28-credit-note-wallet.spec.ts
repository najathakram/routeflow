/**
 * F09 — credit-note wallet UI surfaces (T13 / T14, R10 / R7, REG-B19 / REG-B18).
 *
 * REG-B19 (R10): the credit-notes list and detail pages used to fall back to
 * the linked invoice's raw UUID whenever `invoice.invoiceNumber` was not
 * already on the object — `apps/web/app/(dashboard)/credit-notes/page.tsx`
 * and `[id]/page.tsx` now render `cn.invoice?.invoiceNumber ?? cn.invoiceId`,
 * so a response that DOES carry `invoice.invoiceNumber` must show that string,
 * never the UUID it replaces.
 *
 * REG-B18 (R7): `issue()` (and its route + the "Issue Credit Note" button)
 * were deleted — credit notes are ISSUED on creation, so a DRAFT state and an
 * affordance to promote one out of it can never legitimately appear again.
 *
 * FULLY MOCKED — NO WRITES: both `GET /credit-notes` (list) and
 * `GET /credit-notes/:id` (detail) are intercepted with `page.route` before
 * the page is opened, the same technique `09-regulated-compliance.spec.ts`
 * and `11-product-demand.spec.ts` use. Nothing is created, applied or voided
 * on any tenant. `GET /invoices` is also mocked to an empty page — the detail
 * page's "Apply to Invoice" modal fetches it unconditionally on mount even
 * while closed, and it plays no part in what these two tests assert.
 *
 * Role: OPERATOR (storage state from the "credit-note-wallet" project, same
 * pre-authenticated pattern as every other mocked spec in this suite — see
 * playwright.config.ts). Deploy-only proof, T13/T14 in the test plan
 * (proven-pending-deploy): this project resolving via
 * `npx playwright test --list --project=credit-note-wallet` discharges the
 * pre-merge check; the deploy-signal e2e run discharges REG-B18/REG-B19
 * themselves against the real deployed build.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-tenant-slug",
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: CORS_HEADERS });
  }
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  });
}

const CN_ID = "e2e-cn-28-0001";
// Deliberately UUID-shaped so a regression that falls back to `cn.invoiceId`
// is unmistakable in the rendered DOM, never confusable with the number below.
const INVOICE_UUID = "3f6a9c2e-8b1d-4e77-9c2a-7e1d6a4b9f10";
const INVOICE_NUMBER = "INV-2026-0042";

function creditNoteFixture() {
  return {
    id: CN_ID,
    creditNoteNumber: "CN-2026-0088",
    customerId: "e2e-cust-28-0001",
    customer: { id: "e2e-cust-28-0001", businessName: "E2E Wallet Co" },
    invoiceId: INVOICE_UUID,
    // R10: the fixture the production API now sends alongside invoiceId.
    invoice: { id: INVOICE_UUID, invoiceNumber: INVOICE_NUMBER },
    status: "ISSUED",
    issueDate: "2026-01-01T00:00:00.000Z",
    amount: 42.5,
    amountUsed: 0,
    reason: "E2E fixture — F09 wallet spec",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function mockEmptyInvoices(page: Page) {
  // Consumed by the detail page's "Apply to Invoice" modal, mounted (and its
  // query fired) regardless of whether that modal is open.
  await page.route(/\/api\/v1\/invoices(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } }),
  );
}

test.describe("Credit-note wallet UI: invoice number over UUID, no Issue affordance (F09)", () => {
  test("REG-B19: /credit-notes renders the mocked row's invoice number, never the raw UUID (R10 / T13)", async ({
    page,
  }) => {
    const cn = creditNoteFixture();
    await page.route(/\/api\/v1\/credit-notes(\?.*)?$/, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return fulfillJson(route, {
        data: [cn],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
    });

    await page.goto("/credit-notes");

    // Heading first — asserting the invoice string against a page that never
    // rendered would be meaningless (the absent-UUID half in particular would
    // trivially pass on a blank screen).
    // Scoped to #main-content: the dashboard shell's own <h1> also reads
    // "Credit Notes" (via setTitle), so an unscoped match resolves 2 elements
    // and violates strict mode — same trap as 15-stock-count-ui.spec.ts:150-152.
    await expect(
      page.locator("#main-content").getByRole("heading", { name: "Credit Notes" }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText(INVOICE_NUMBER)).toBeVisible();
    await expect(page.getByText(INVOICE_UUID)).toHaveCount(0);
  });

  test("REG-B18: /credit-notes/:id loads (number heading) with no Issue Credit Note button (R7 / T14)", async ({
    page,
  }) => {
    // REG-B18's oracle needs a fixture the pre-fix build would still show an
    // Issue button for, or a green result is not evidence of anything: DRAFT
    // is the phantom status the deleted flow keyed its button on, wire-shaped
    // but never actually issuable post-P2 (status is created ISSUED).
    const cn = { ...creditNoteFixture(), status: "DRAFT" };
    await page.route(new RegExp(`/api/v1/credit-notes/${CN_ID}(\\?.*)?$`), (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return fulfillJson(route, cn);
    });
    await mockEmptyInvoices(page);

    await page.goto(`/credit-notes/${CN_ID}`);

    // Scoped to #main-content for the same reason as the list heading above —
    // the detail page's own <h1> (setTitle) duplicates this <h2> string.
    await expect(
      page.locator("#main-content").getByRole("heading", { name: cn.creditNoteNumber }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Issue Credit Note", exact: true })).toHaveCount(
      0,
    );
  });
});
