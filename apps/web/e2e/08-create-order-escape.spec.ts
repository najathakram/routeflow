/**
 * WP-1: Create Order — Escape scopes to the add-item sub-flow (no whole-order
 * discard) + auto-park-to-draft safety net, plus the order-date round trip
 * through a parked draft.
 *
 * Role: OPERATOR (pre-authed via the "operator" Playwright project storage state).
 * Runs against the seeded e2e tenant, which has customers + products; the
 * draft-resume tests mock every draft endpoint so they write to no tenant. The
 * ESC tests DO park real drafts (that's the behavior under test) — afterEach
 * deletes them via the API so the tenant's dock doesn't accumulate residue.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Operator — Create Order Escape scoping (WP-1)", () => {
  // Both ESC tests dismiss a STARTED order, so each parks one real draft on the
  // e2e tenant (the auto-park net is the behavior under test). Capture the ids
  // from the builder's POST /drafts and delete them in afterEach — before this,
  // every run left two more rows in the operator's dock forever (and GET /drafts
  // caps at 50, so the residue would eventually mask real fixtures).
  const parkedDraftIds: string[] = [];
  const pendingParks: Array<Promise<void>> = [];

  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    page.on("response", (resp) => {
      if (resp.request().method() !== "POST") return;
      if (!/\/api\/v1\/drafts(\?.*)?$/.test(resp.url())) return;
      pendingParks.push(
        resp
          .json()
          .then((body: { id?: string }) => {
            if (resp.ok() && body?.id) parkedDraftIds.push(body.id);
          })
          .catch(() => {}),
      );
    });
    await page.goto("/orders");
  });

  test.afterEach(async ({ page, request }) => {
    // The park toast each test waits for guarantees the POST response landed;
    // this only flushes the listener's json() parse.
    await Promise.all(pendingParks.splice(0));
    const ids = parkedDraftIds.splice(0);
    if (ids.length === 0) return;
    const token = await operatorAccessToken(page);
    if (!token) return;
    const api = apiBase(page.url());
    for (const id of ids) {
      await request
        .delete(`${api}/api/v1/drafts/${id}`, {
          headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
        })
        .catch(() => {});
    }
  });

  async function openBuilderWithCustomer(page: import("@playwright/test").Page) {
    await page
      .getByRole("button", { name: /new order/i })
      .first()
      .click();
    const title = page.getByRole("heading", { name: "Create Order" });
    await expect(title).toBeVisible({ timeout: 10_000 });
    // Pick the first customer so the product search renders. "e" matches most
    // seeded business names on the e2e tenant. The suggestion list is a
    // SIBLING of the search input — a page-wide "ul li button" grabs the
    // sidebar nav toggle first (the selector this replaces did exactly that).
    await page.getByPlaceholder("Search by business name…").fill("e");
    await page
      .locator('input[placeholder="Search by business name…"] ~ ul li button')
      .first()
      .click({ timeout: 10_000 });
    return title;
  }

  test("ESC-01 Escape while adding an item clears the item search but keeps the order open", async ({
    page,
  }) => {
    const title = await openBuilderWithCustomer(page);

    const productSearch = page.getByPlaceholder("Search by name, SKU or scan barcode…");
    await productSearch.fill("test");
    await expect(productSearch).toHaveValue("test");

    // First Escape: cancels ONLY the item sub-flow. The order builder stays open.
    await productSearch.press("Escape");
    await expect(productSearch).toHaveValue("");
    await expect(title).toBeVisible();

    // Second Escape (no active sub-flow) dismisses the builder. A customer is
    // selected, so the dismissal auto-parks — wait for the toast so the park's
    // POST has definitely landed before afterEach deletes the draft.
    await page.keyboard.press("Escape");
    await expect(title).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(/saved as draft|draft parked/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("ESC-02 dismissing a started order auto-parks it as a draft (nothing lost)", async ({
    page,
  }) => {
    const title = await openBuilderWithCustomer(page);

    // Cancel with a customer selected → the order is parked to a draft, not lost.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(title).toBeHidden({ timeout: 10_000 });

    // The parked order surfaces in the draft dock (toast confirms the save).
    await expect(page.getByText(/saved as draft|draft parked/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ─── Order date through a parked draft ────────────────────────────────────────

const DRAFT_ID = "e2e-draft-order-date";
/** Always in the past, so the picker's `max` never rejects it as the suite ages. */
const BACKDATE = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
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

/** A parked builder state — the shape `OrderDraftPayload` serializes. */
function draftPayload(orderDate: string) {
  return {
    customer: { id: "e2e-cust-1", businessName: "Acme Provisions", pricingTier: 1 },
    lineItems: [
      {
        tempId: "li-1",
        productId: "e2e-prod-1",
        productName: "Acme Cola 12oz",
        unit: "case",
        listPrice: 8.5,
        unitPrice: 8.5,
        priceType: "STANDARD",
        qty: 2,
      },
    ],
    orderDiscount: "",
    shippingFee: "",
    requestedDeliveryDate: "",
    orderDate,
    notes: "",
    urgent: false,
    floorAcked: [],
  };
}

function draftFixture(orderDate: string) {
  return {
    id: DRAFT_ID,
    kind: "ORDER",
    customerId: "e2e-cust-1",
    customerName: "Acme Provisions",
    title: "Order, Acme Provisions",
    payload: draftPayload(orderDate),
    device: "Desktop web",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

/**
 * Serves the resumed draft and captures every autosave PATCH body. Anchored to
 * the /api/v1 prefix so the /orders page navigation is never intercepted.
 */
async function mockDraft(page: Page, orderDate: string, patched: unknown[] = []) {
  await page.route(new RegExp(`/api/v1/drafts/${DRAFT_ID}(\\?.*)?$`), (route) => {
    if (route.request().method() === "PATCH") {
      patched.push(route.request().postDataJSON());
      return fulfillJson(route, draftFixture(orderDate));
    }
    return fulfillJson(route, draftFixture(orderDate));
  });
  return patched;
}

const SKIP_REASON = "Draft resume not present in this web build (pre-deploy)";

/** Opens the builder on a resumed draft; false when the build predates the flow. */
async function resumeDraft(page: Page): Promise<boolean> {
  await page.goto(`/orders?resumeDraft=${DRAFT_ID}`);
  return page
    .getByRole("heading", { name: "Resume draft" })
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe("Operator — order date survives a parked draft (WP-4)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("DRAFT-01 resuming a draft restores the order date it was parked with", async ({ page }) => {
    await mockDraft(page, BACKDATE);
    test.skip(!(await resumeDraft(page)), SKIP_REASON);

    await expect(page.locator("#order-date")).toHaveValue(BACKDATE);
  });

  test("DRAFT-02 typing an order date autosaves it into the draft payload", async ({ page }) => {
    // Parked with no date, so the only way orderDate reaches a PATCH body is the
    // edit below — which also proves the autosave memo re-runs on that field.
    const patched = await mockDraft(page, "");
    test.skip(!(await resumeDraft(page)), SKIP_REASON);

    const orderDateInput = page.locator("#order-date");
    await expect(orderDateInput).toHaveValue("");
    await orderDateInput.fill(BACKDATE);

    await expect
      .poll(
        () =>
          patched.map((body) => (body as { payload?: { orderDate?: string } })?.payload?.orderDate),
        { timeout: 15_000 },
      )
      .toContain(BACKDATE);
  });

  test("DRAFT-03 a backdated order cannot be merged into the customer's open order", async ({
    page,
  }) => {
    await mockDraft(page, BACKDATE);
    await page.route(/\/api\/v1\/orders\/active(\?.*)?$/, (route) =>
      fulfillJson(route, {
        id: "e2e-open-order-1",
        orderNumber: "ORD-0042",
        status: "PENDING",
        itemCount: 3,
        total: 61.5,
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    test.skip(!(await resumeDraft(page)), SKIP_REASON);
    await expect(page.locator("#order-date")).toHaveValue(BACKDATE);

    await page.getByRole("button", { name: "Create Order", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Open order exists" })).toBeVisible();

    // Merge routes through the existing order and would drop the backdate.
    await expect(page.getByRole("button", { name: /Merge into/ })).toBeDisabled();
    await expect(page.getByText(/backdated order has to be created separately/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Create as separate/ })).toBeEnabled();
  });
});

// B499 — the product-search row's scan button, at a real phone width. No customer is picked
// (the Products section renders unconditionally, and dismissing WITHOUT a selected customer
// never auto-parks a draft — see ESC-02 above — so this needs no draft cleanup).
test.describe("Operator — Create Order product search scan button, mobile (B499)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("MOBILE-01 the scan button renders beside the search input, ≥44px, no horizontal overflow", async ({
    page,
    context,
  }) => {
    await setTenantCookie(context, BASE);
    await page.goto("/orders");
    await page
      .getByRole("button", { name: /new order/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible({
      timeout: 10_000,
    });

    const search = page.getByPlaceholder("Search by name, SKU or scan barcode…");
    const scanButton = page.getByRole("button", { name: "Scan barcode" });
    await expect(search).toBeVisible();
    await expect(scanButton).toBeVisible();

    const scanBox = await scanButton.boundingBox();
    expect(scanBox).not.toBeNull();
    expect(scanBox!.width).toBeGreaterThanOrEqual(44);
    expect(scanBox!.height).toBeGreaterThanOrEqual(44);

    // Neither control extends past the 390px viewport — the classic "add a button, blow the
    // row out to the right" mobile regression.
    const searchBox = await search.boundingBox();
    expect(searchBox).not.toBeNull();
    expect(scanBox!.x + scanBox!.width).toBeLessThanOrEqual(390);
    expect(searchBox!.x).toBeGreaterThanOrEqual(0);

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});

// B506 — the orders list's delivery date-range filter, at a real phone width.
// Every other filter control on this row already wraps at 390px; the date
// range was the one block that didn't wrap internally, so its "to" field ran
// past the right edge.
test.describe("Operator — Orders list delivery date-range filter, mobile (B506)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("MOBILE-02 both date inputs are visible, interactive, and stay inside the viewport", async ({
    page,
    context,
  }) => {
    await setTenantCookie(context, BASE);
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible({ timeout: 10_000 });

    const from = page.getByTitle("Delivery date from");
    const to = page.getByTitle("Delivery date to");
    await expect(from).toBeVisible();
    await expect(to).toBeVisible();

    const fromBox = await from.boundingBox();
    const toBox = await to.boundingBox();
    expect(fromBox).not.toBeNull();
    expect(toBox).not.toBeNull();
    // The regression this pins: the "to" field's right edge ran off past 390px
    // (unreachable without an unhinted horizontal scroll) instead of wrapping
    // to a second line the way every other filter control on this row does.
    expect(fromBox!.x + fromBox!.width).toBeLessThanOrEqual(390);
    expect(toBox!.x + toBox!.width).toBeLessThanOrEqual(390);
    expect(fromBox!.x).toBeGreaterThanOrEqual(0);
    expect(toBox!.x).toBeGreaterThanOrEqual(0);

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    // Both fields actually take input, not just visually present.
    await from.fill("2026-10-01");
    await expect(from).toHaveValue("2026-10-01");
    await to.fill("2026-10-15");
    await expect(to).toHaveValue("2026-10-15");
  });
});
