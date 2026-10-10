/**
 * #2080 (P0, owner-reported production bug, iPhone). The staff order dialog's own scroll
 * body (`CreateOrderModal.tsx`, `form.max-h-[65vh].overflow-y-auto`) panned sideways on a
 * vertical swipe; section labels lost their first letters.
 *
 * Root cause: the "Requested Delivery Date" / "Order date" `<input type="date">`s are
 * `w-full`. On iOS, WebKit's RenderThemeIOS.mm `adjustInputElementButtonStyle` (called from
 * `adjustMenuListButtonStyle`, i.e. only while appearance is not `none`) runs AFTER the
 * cascade and overrides author CSS: "Always Enforce padding: 0 0.5em", then min-width
 * + `box-sizing: content-box` for any width that is not a fixed length. It is NOT a UA-stylesheet
 * rule (an earlier review assumed it was): preflight's border-box and `px-3` cannot beat it,
 * which is why production master is broken despite both. `w-full` therefore rendered 100%
 * of the content box plus padding and border (+12px of body overflow, measured).
 * Fix: `app/globals.css` sets `-webkit-appearance: none; appearance: none;
 * box-sizing: border-box; min-width: 0` on every date/time input, inside `:where()`.
 *
 * Chromium has no such adjustment, so this spec applies `applyIosDateInputAdjustment`
 * (helpers/ios-date-input.ts) after the cart is built: it visits EVERY date/time input and
 * re-creates WebKit's post-cascade step with inline styles under WebKit's own conditions. It
 * never looks for the fix; the precondition below asserts only that it ran over the dialog's
 * date inputs. Base 35a3d5af goes red (+12px), the fix goes green (0) in the compiled-CSS
 * harness recorded on PR #2086; the F2 compose lane runs this spec itself (master red, fix
 * green) as the landing proof.
 *
 * `#1288`'s shared element walk (`findViewportOverflow`) cannot see this class of bug alone
 * (no box escapes the viewport, no `overflow-hidden` element holds it), so the body's own
 * `scrollWidth - clientWidth` is asserted directly; the walk still runs as a second net.
 *
 * Cart shape approximates the owner's report (`e2e-seed.js` fixtures): the boxed product
 * (Case/Unit toggle, cases + units inputs, Case price input), a per-line note, and an
 * order discount + shipping fee. No regulated-category fixture is cart-addable in
 * `e2e-seed.js` today, so none is added.
 */
import { test, expect, type Page } from "@playwright/test";
import { findViewportOverflow } from "./helpers/overflow";
import { applyIosDateInputAdjustment } from "./helpers/ios-date-input";
import { setTenantCookie } from "./helpers/auth";

const VIEWPORTS = [
  { width: 320, height: 690, label: "320" },
  { width: 375, height: 812, label: "375" },
  { width: 390, height: 844, label: "390" },
  { width: 430, height: 932, label: "430" },
] as const;

const DIALOG_BODY_SELECTOR = 'form[class*="overflow-y-auto"]';

async function openBuilderWithRealisticCart(page: Page) {
  await page.goto("/orders");
  await page
    .getByRole("button", { name: /new order/i })
    .first()
    .click();
  const title = page.getByRole("heading", { name: "Create Order" });
  await expect(title).toBeVisible({ timeout: 10_000 });

  // Same seeded-customer pattern as spec 08 (openBuilderWithCustomer).
  await page.getByPlaceholder("Search by business name…").fill("E2E Fixture Deli Three");
  await page
    .locator('input[placeholder="Search by business name…"] ~ ul li button')
    .first()
    .click({ timeout: 10_000 });

  // The one seeded boxed product — Case/Unit toggle, cases+units inputs,
  // Case price input, and a name long enough to stress-test the row.
  const productSearch = page.getByPlaceholder("Search by name, SKU or scan barcode…");
  await productSearch.fill("E2E Fixture Boxed Case");
  // The dropdown shows "Create new product" (and "No products found") before the search
  // response lands; `.first()` alone raced into the create-product form.
  await page
    .locator('input[placeholder="Search by name, SKU or scan barcode…"] ~ ul li button', {
      hasNotText: "Create new product",
    })
    .first()
    .click({ timeout: 10_000 });

  // Per-line note (StickyNote icon toggle on the just-added row).
  await page.getByTitle("Add flavor / note").first().click();
  await page
    .getByPlaceholder(/flavor or note for this item/i)
    .first()
    .fill("Deliver to the back dock — buzzer is broken, call on arrival");

  // Order-level discount + shipping — both render once the cart is non-empty.
  await page.getByLabel("Order discount").fill("5.00");
  await page.getByLabel("Shipping fee").fill("12.50");

  return title;
}

async function bodyScrollOverflowPx(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return NaN;
    return el.scrollWidth - el.clientWidth;
  }, DIALOG_BODY_SELECTOR);
}

for (const vp of VIEWPORTS) {
  test.describe(`create-order dialog — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`dialog body has no horizontal overflow under the iOS date-input adjustment (${vp.label}px)`, async ({
      page,
    }) => {
      await openBuilderWithRealisticCart(page);
      await expect(page.locator("#delivery-date")).toBeVisible();
      await expect(page.locator("#order-date")).toBeVisible();

      const { visited } = await applyIosDateInputAdjustment(page);
      expect(
        visited,
        "the iOS date-input adjustment did not reach the dialog's two date inputs",
      ).toBeGreaterThanOrEqual(2);

      const overflowPx = await bodyScrollOverflowPx(page);
      expect(
        overflowPx,
        `dialog body scrollWidth exceeds clientWidth by ${overflowPx}px at ${vp.label}px ` +
          `under the iOS date-input adjustment — the owner's reported sideways pan`,
      ).toBeLessThanOrEqual(0);

      const { offenders } = await findViewportOverflow(page);
      expect(
        offenders,
        `viewport overflow (shared walk) at ${vp.label}px — ${offenders.length} offender(s), worst: ${JSON.stringify(offenders.slice(0, 5))}`,
      ).toHaveLength(0);
    });

    /**
     * Not #2080: the boxed line's qty column (`line-qty-controls`) is `min-w-0` below `sm`,
     * so its own box fits its `minmax(0,1fr)` track by construction; measuring that box
     * proves nothing. This measures the CONTENT against the TRACK: the cases/units row's
     * scrollWidth against its clientWidth, and every descendant's right edge against the
     * track's right boundary (the actions column's left edge minus the row's column-gap).
     * "[n] cases + [n] units" needs ~186px in the app font and the track is ~176-182px at
     * 320px, so the row wraps its second group instead of running under the line total.
     */
    test(`the boxed line's cases/units content fits its grid track (${vp.label}px)`, async ({
      page,
    }) => {
      await openBuilderWithRealisticCart(page);
      const qtyColumn = page.getByTestId("line-qty-controls").first();
      await expect(qtyColumn).toBeVisible();
      await expect(page.getByTestId("line-qty-cases-row").first()).toBeVisible();

      const m = await qtyColumn.evaluate((col) => {
        const li = col.parentElement as HTMLElement;
        const actions = li.querySelector('[data-testid="line-actions-column"]');
        const row = col.querySelector('[data-testid="line-qty-cases-row"]');
        const gap = parseFloat(getComputedStyle(li).columnGap) || 0;
        const trackRight = actions ? actions.getBoundingClientRect().left - gap : NaN;
        let maxRight = -Infinity;
        col.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) maxRight = Math.max(maxRight, r.right);
        });
        return {
          rowOverflow: row ? row.scrollWidth - row.clientWidth : NaN,
          contentPastTrack: Math.round((maxRight - trackRight) * 100) / 100,
          colWidth: Math.round(col.getBoundingClientRect().width),
        };
      });
      expect(
        m.rowOverflow,
        `cases/units row content overflows its ${m.colWidth}px track by ${m.rowOverflow}px at ${vp.label}px`,
      ).toBeLessThanOrEqual(0);
      expect(
        m.contentPastTrack,
        `qty-controls content runs ${m.contentPastTrack}px past its ${m.colWidth}px track at ${vp.label}px`,
      ).toBeLessThanOrEqual(0);
    });
  });
}

/**
 * #2080 v2, the owner's exact symptom: the dialog's LEFT side slid out of view while a date
 * was being typed. Create AND the resumed-draft (edit) path share the dialog, so both are
 * driven at 1440/768/390 with a long product name on the line and the delivery date focused,
 * under the same WebKit post-cascade model as above. After every keystroke: the document never
 * scrolls sideways (`documentElement.scrollWidth <= innerWidth`), the dialog's left edge stays
 * on screen, and the dialog body has not panned (`scrollLeft === 0`).
 *
 * The long name is injected, never seeded: the create path rewrites the seeded boxed product's
 * name in the /products responses; the resume path serves a mocked draft (spec 08's pattern).
 * Nothing is written to the tenant beyond what spec 56's create path already does (no submit).
 */
const LONG_NAME =
  "E2E Fixture Extra Long Product Name — Assorted Sparkling Citrus Variety Pack, " +
  "Glass Bottles, 24 x 355ml, Case of Twenty-Four (Seasonal)";
const SEEDED_BOXED_NAME = "E2E Fixture Boxed Case";
const V2_VIEWPORTS = [
  { width: 1440, height: 900, label: "1440" },
  { width: 768, height: 1024, label: "768" },
  { width: 390, height: 844, label: "390" },
] as const;
const RESUME_DRAFT_ID = "e2e-draft-2080-long-name";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

function renameDeep(value: unknown): unknown {
  if (value === SEEDED_BOXED_NAME) return LONG_NAME;
  if (Array.isArray(value)) return value.map(renameDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameDeep(v)]));
  }
  return value;
}

async function longNameOnProductSearch(page: Page) {
  await page.route(/\/api\/v1\/products(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = renameDeep(await res.json());
    return route.fulfill({ response: res, json: body });
  });
}

function draftFixtureLongName() {
  const payload = {
    customer: { id: "e2e-cust-1", businessName: "Acme Provisions", pricingTier: 1 },
    lineItems: [
      {
        tempId: "li-1",
        productId: "e2e-prod-1",
        productName: LONG_NAME,
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
    orderDate: "",
    notes: "",
    urgent: false,
    floorAcked: [],
  };
  return {
    id: RESUME_DRAFT_ID,
    kind: "ORDER",
    customerId: "e2e-cust-1",
    customerName: "Acme Provisions",
    title: "Order, Acme Provisions",
    payload,
    device: "Desktop web",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

async function openResumedDraftWithLongName(page: Page): Promise<boolean> {
  await page.route(new RegExp(`/api/v1/drafts/${RESUME_DRAFT_ID}(\\?.*)?$`), (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204 });
    return route.fulfill({ status: 200, json: draftFixtureLongName() });
  });
  await page.goto(`/orders?resumeDraft=${RESUME_DRAFT_ID}`);
  return page
    .getByRole("heading", { name: "Resume draft" })
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

async function panMetrics(page: Page) {
  return page.evaluate((sel) => {
    const body = document.querySelector(sel) as HTMLElement | null;
    const dialog = (document.querySelector('[role="dialog"]') ?? body) as HTMLElement | null;
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      dialogLeft: dialog ? Math.round(dialog.getBoundingClientRect().left * 100) / 100 : NaN,
      bodyScrollLeft: body ? body.scrollLeft : NaN,
    };
  }, DIALOG_BODY_SELECTOR);
}

async function typeDateAndAssertNoPan(page: Page, label: string) {
  const { visited } = await applyIosDateInputAdjustment(page);
  expect(
    visited,
    "the iOS date-input adjustment did not reach the dialog's date inputs",
  ).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(LONG_NAME).first()).toBeVisible();

  const date = page.locator("#delivery-date");
  await date.focus();
  await expect(date).toBeFocused();
  for (const key of "12312026") {
    await page.keyboard.press(key);
    const m = await panMetrics(page);
    expect(
      m.docOverflow,
      `document scrolls sideways by ${m.docOverflow}px while typing (${label})`,
    ).toBeLessThanOrEqual(0);
    expect(
      m.dialogLeft,
      `dialog left edge at ${m.dialogLeft}px while typing (${label})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      m.bodyScrollLeft,
      `dialog body panned ${m.bodyScrollLeft}px while typing (${label})`,
    ).toBe(0);
  }
  await expect(date).toHaveValue("2026-12-31");
  await page.screenshot({
    path: `test-results/2080-proof/${label}.png`,
    fullPage: false,
  });
}

for (const vp of V2_VIEWPORTS) {
  test.describe(`#2080 v2 — long name + focused date — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`create: no sideways pan while typing a date (${vp.label}px)`, async ({ page }) => {
      await longNameOnProductSearch(page);
      await openBuilderWithRealisticCart(page);
      await typeDateAndAssertNoPan(page, `create-${vp.label}`);
    });

    test(`resume draft: no sideways pan while typing a date (${vp.label}px)`, async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      test.skip(
        !(await openResumedDraftWithLongName(page)),
        "Draft resume not present in this web build",
      );
      await typeDateAndAssertNoPan(page, `resume-${vp.label}`);
    });
  });
}
