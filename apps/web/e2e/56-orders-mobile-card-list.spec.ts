/**
 * Orders list mobile layout — B823, spec 56.
 *
 * Reported at 390px: /orders kept its desktop table (TOTAL clipped at the
 * right edge, with `overflow-x-auto` present but no visible affordance that
 * the table could scroll at all), and the persistent parked-draft dock
 * (DraftDock, `(dashboard)/layout.tsx`) — `position: absolute`, floating over
 * the bottom-left of the content area on every dashboard screen, not inside
 * the scrollable `<main>` — could land on top of the first visible order
 * rows, since the toolbar above the list leaves little vertical room at this
 * width.
 *
 * Fix (`(dashboard)/orders/page.tsx`): a `md:hidden` card list (mirroring
 * `buyer/portal/[seller]/orders/page.tsx`'s own table→cards pattern) replaces
 * the table below md, so nothing needs horizontal scroll — TOTAL is always
 * in the card's own top row. The desktop table itself is now `hidden
 * md:block`, unchanged in shape. A conditional spacer (`hasDrafts &&
 * "h-40 md:hidden"`) reserves clearance above the list, in document flow,
 * whenever `useDrafts()` reports a parked draft — pushing the cards down
 * far enough that the dock's overlay band never reaches them.
 *
 * Role: OPERATOR (pre-authed via the "orders-mobile-card-list" Playwright
 * project's operator storage state). Runs against the seeded e2e tenant.
 * Read-only: no order/draft is created or mutated — the "parked draft"
 * scenario mocks GET /api/v1/drafts instead, same technique
 * 08-create-order-escape.spec.ts's DRAFT-01/02 tests use, so this never
 * writes to the tenant and needs no cleanup.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

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

const MOCK_DRAFT = {
  id: "e2e-mock-draft-b823",
  kind: "ORDER",
  customerId: "e2e-cust-1",
  customerName: "Acme Provisions",
  title: "Order, Acme Provisions",
  payload: { customer: { id: "e2e-cust-1", businessName: "Acme Provisions" }, lineItems: [] },
  device: "Desktop web",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function mockOneParkedDraft(page: Page) {
  await page.route(/\/api\/v1\/drafts(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return fulfillJson(route, [MOCK_DRAFT]);
  });
}

test.describe("Orders list — mobile card layout + dock clearance (B823)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("390px: the card list renders, the desktop table does not", async ({ page }) => {
    await page.goto("/orders");
    const cards = page.locator("ul.space-y-3.md\\:hidden > li");
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("table")).toBeHidden();
  });

  test("390px: TOTAL is visible on the first card without any horizontal scroll", async ({
    page,
  }) => {
    await page.goto("/orders");
    const firstCard = page.locator("ul.space-y-3.md\\:hidden > li").first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });

    // The total is the shrink-0 font-mono span in the card's top row — assert its
    // box sits fully inside the 390px viewport, not just present in the DOM.
    const total = firstCard.locator("span.font-mono.text-sm.font-semibold").first();
    await expect(total).toBeVisible();
    const box = await total.boundingBox();
    expect(box, "TOTAL element has no bounding box").not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // No element on the page escapes the viewport horizontally at all — the old
    // table relied on overflow-x-auto (technically reachable by scroll, but with
    // no affordance); the card list needs no scroll in the first place.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });

  test("390px: a parked draft's dock never overlaps the first order card", async ({ page }) => {
    await mockOneParkedDraft(page);
    await page.goto("/orders");

    const firstCard = page.locator("ul.space-y-3.md\\:hidden > li").first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    // The dock's own draft chip (DraftDock.tsx) — "Draft" pill + Resume button.
    const dockChip = page.getByRole("button", { name: "Resume" }).first();
    await expect(dockChip).toBeVisible({ timeout: 10_000 });

    const cardBox = await firstCard.boundingBox();
    const dockBox = await dockChip.boundingBox();
    expect(cardBox, "first order card has no bounding box").not.toBeNull();
    expect(dockBox, "draft dock chip has no bounding box").not.toBeNull();

    // Two boxes overlap iff both axes intersect. Assert they do NOT — either box
    // sits fully above/below or fully left/right of the other.
    const verticallySeparate =
      cardBox!.y + cardBox!.height <= dockBox!.y || dockBox!.y + dockBox!.height <= cardBox!.y;
    const horizontallySeparate =
      cardBox!.x + cardBox!.width <= dockBox!.x || dockBox!.x + dockBox!.width <= cardBox!.x;
    expect(
      verticallySeparate || horizontallySeparate,
      `dock chip ${JSON.stringify(dockBox)} overlaps first order card ${JSON.stringify(cardBox)}`,
    ).toBe(true);
  });

  // Opus (#938 5808147410, at 51ad5848): "the top spacer can't clear the absolute
  // bottom-24 DraftDock. Later cards, the last card and the pager stay under the chip."
  // The dock is `position: absolute` OUTSIDE <main>'s scroll container, so it stays
  // pinned to the same screen band regardless of scroll — a top-only spacer helps the
  // FIRST paint only. This is the actual regression: scroll to the very bottom of the
  // list and assert the LAST card and the pager both clear the dock's band, which the
  // bottom spacer (page.tsx, right after the pager) exists to guarantee.
  test("390px: scrolled to the bottom, the LAST card and the pager clear a live dock", async ({
    page,
  }) => {
    await mockOneParkedDraft(page);
    await page.goto("/orders");

    const cards = page.locator("ul.space-y-3.md\\:hidden > li");
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const dockChip = page.getByRole("button", { name: "Resume" }).first();
    await expect(dockChip).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Layout settles a frame after the scroll — the dock's own position is fixed
    // relative to its non-scrolling ancestor, so no wait-for-scroll-end is needed
    // beyond letting that frame paint.
    await page.waitForTimeout(100);

    const lastCard = cards.last();
    // #2057 review: the pager now also renders (hidden) inside the desktop table's own
    // footer, so a bare text match would ambiguously grab whichever comes first in DOM
    // order regardless of visibility — data-testid pins it to the mobile-only instance.
    const pager = page.getByTestId("pager-mobile");
    await expect(lastCard).toBeVisible();
    await expect(pager).toBeVisible();

    const dockBox = await dockChip.boundingBox();
    expect(dockBox, "draft dock chip has no bounding box").not.toBeNull();

    for (const [label, locator] of [
      ["last card", lastCard],
      ["pager", pager],
    ] as const) {
      const box = await locator.boundingBox();
      expect(box, `${label} has no bounding box`).not.toBeNull();
      const verticallySeparate =
        box!.y + box!.height <= dockBox!.y || dockBox!.y + dockBox!.height <= box!.y;
      const horizontallySeparate =
        box!.x + box!.width <= dockBox!.x || dockBox!.x + dockBox!.width <= box!.x;
      expect(
        verticallySeparate || horizontallySeparate,
        `dock chip ${JSON.stringify(dockBox)} overlaps the ${label} ${JSON.stringify(box)}`,
      ).toBe(true);
    }
  });

  // Opus called click/select parity "sound" by reading the code, not by a live test —
  // pin it for real: entering select mode at 390 and tapping a card selects it, the
  // same toggleSelect/checkbox logic the desktop table's row already proved.
  test("390px: entering select mode and tapping a card selects it (no navigation)", async ({
    page,
  }) => {
    await page.goto("/orders");
    const cards = page.locator("ul.space-y-3.md\\:hidden > li");
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Select" }).click();
    const firstCard = cards.first();
    await firstCard.click();

    // Selecting must not navigate away from /orders.
    await expect(page).toHaveURL(/\/orders(\?.*)?$/);
    // The card's own checkbox reflects the selection (selectMode renders it, checked
    // tracks the `selected` Set — same state the bulk-action bar's count reads).
    await expect(firstCard.locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.getByText("1 selected")).toBeVisible();
  });

  // #2057 review: the desktop table's own Delivery Date column was missing from the
  // card entirely.
  test("390px: the card shows a Delivery row (the desktop table's own column)", async ({
    page,
  }) => {
    await page.goto("/orders");
    const firstCard = page.locator("ul.space-y-3.md\\:hidden > li").first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await expect(firstCard.getByText(/^Delivery:/)).toBeVisible();
  });

  // #2057 review: mobile had no way to sort at all — the desktop sort is column-header
  // clicks, invisible below md. Pin that the new sort control actually reorders the list,
  // not just that it renders.
  test("390px: the sort control changes the card order", async ({ page }) => {
    await page.goto("/orders");
    const cards = page.locator("ul.space-y-3.md\\:hidden > li");
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    const before = await cards.evaluateAll((els) =>
      els.map((el) => el.querySelector("span.font-mono.text-xs.font-semibold")?.textContent),
    );

    const sortSelect = page.getByRole("combobox", { name: "Sort orders by" });
    await expect(sortSelect).toBeVisible();
    // Default is "Created" desc — switch to "Order #", which starts ascending (the sort
    // control resets direction on a column change, matching the desktop header-click UX).
    await sortSelect.selectOption({ label: "Order #" });

    await expect
      .poll(async () =>
        cards.evaluateAll((els) =>
          els.map((el) => el.querySelector("span.font-mono.text-xs.font-semibold")?.textContent),
        ),
      )
      .not.toEqual(before);

    const after = await cards.evaluateAll((els) =>
      els.map((el) => el.querySelector("span.font-mono.text-xs.font-semibold")?.textContent),
    );
    const sorted = [...after].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(after).toEqual(sorted);
  });
});
