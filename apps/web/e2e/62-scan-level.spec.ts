/**
 * #2717 M4a-1 (SA-578 test 24 / SA-580): web order-entry wedge scans land the LEVEL of the code.
 *   R1  a UNIT code adds ONE PIECE          R1  a BOX code adds ONE CASE
 *   R2  a SHARED code adds the default unit (a CASE at upb>1, SA-580b)        (both named web behaviour changes: unitSku scan -> a piece)
 * At 1440 / 768 / 390 px.
 *
 * SKELETON, NOT RUNNABLE HERE (authoring lane has no container runtime, no browser stack): the Mac mini
 * takes the run from the pushed sha, per the capture-brief rule. Not yet in playwright.config.ts —
 * the builder registers the project (and the LOCAL-LANE allow-list) with the implementation.
 *
 * Hermetic by design: `GET /products/barcode/:code` is fulfilled from a fixture (a boxed product,
 * upb 12, with the scanMatch the server will return), so no tenant data is read or written and no
 * order is placed; the dialog is escaped without a customer, so nothing parks.
 *
 * SELECTORS by data-testid — the implementation adds these (none exist at this base):
 *   create-order-product-search   the scan/search input in the create-order dialog
 *   order-line-cases              the whole-cases input of the order line for the product
 *   order-line-loose              the loose-pieces input of that line (present whenever pieces > 0)
 *   order-line-pcs-total          the "<n> pcs total" text of that line
 * RED until then: the locators do not exist.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

const PRODUCT = {
  id: "e2e-scan-level-boxed",
  name: "E2E Scan Level Chips",
  sku: "E2E-SL-12",
  unitSku: "E2E-SL-1",
  barcode: null,
  unit: "case",
  unitsPerBox: 12,
  pricePerUnit: "30.00",
  isActive: true,
};

const CODES = {
  unit: { code: "E2E-UNIT-CODE", levels: ["UNIT"] },
  box: { code: "E2E-BOX-CODE", levels: ["BOX"] },
  shared: { code: "E2E-SHARED-CODE", levels: ["BOX", "UNIT"] },
  // SA-580b: a shared code on an upb-1 product adds the default unit -> today's plain +1 line.
  sharedPlain: {
    code: "E2E-SHARED-PLAIN",
    levels: ["BOX", "UNIT"],
    product: { unitsPerBox: 1, unit: "each" },
  },
} as const;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

async function stubBarcodeLookup(page: Page) {
  await page.route("**/api/v1/products/barcode/**", async (route) => {
    const code = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const hit = Object.values(CODES).find((c) => c.code === code);
    if (!hit) return route.fulfill({ status: 404, json: { message: "Product not found" } });
    return route.fulfill({
      json: {
        ...PRODUCT,
        ...("product" in hit ? hit.product : {}),
        barcodes: hit.levels.map((level) => ({ code: hit.code, level })),
        scanMatch: { code: hit.code, levels: hit.levels },
      },
    });
  });
}

/** A hardware wedge scanner types the code into the focused search box and presses Enter. */
async function wedgeScan(page: Page, code: string) {
  const search = page.getByTestId("create-order-product-search");
  await search.fill(code);
  await search.press("Enter");
}

for (const vp of VIEWPORTS) {
  test.describe(`Operator — scan level (R1/R2) @ ${vp.name}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test.beforeEach(async ({ page, context }) => {
      await setTenantCookie(context, BASE);
      await stubBarcodeLookup(page);
      await page.goto("/orders");
      await page
        .getByRole("button", { name: /new order|create order/i })
        .first()
        .click();
      await expect(page.getByTestId("create-order-product-search")).toBeVisible();
    });

    test("R1: a unit code adds one PIECE — 0 cases + 1 loose, shown on the line", async ({
      page,
    }) => {
      await wedgeScan(page, CODES.unit.code);
      await expect(page.getByTestId("order-line-cases")).toHaveValue("0");
      await expect(page.getByTestId("order-line-loose")).toHaveValue("1");
      await expect(page.getByTestId("order-line-pcs-total")).toContainText("1 pcs total");
    });

    test("R1: a box code adds one CASE — 1 case, no loose", async ({ page }) => {
      await wedgeScan(page, CODES.box.code);
      await expect(page.getByTestId("order-line-cases")).toHaveValue("1");
      await expect(page.getByTestId("order-line-loose")).toHaveCount(0);
      await expect(page.getByTestId("order-line-pcs-total")).toContainText("12 pcs total");
    });

    test("R2 (SA-580b): a shared code adds the default unit (one CASE at upb 12), and a repeat merges into the same line", async ({
      page,
    }) => {
      await wedgeScan(page, CODES.shared.code);
      await expect(page.getByTestId("order-line-cases")).toHaveValue("1");
      await wedgeScan(page, CODES.shared.code);
      await expect(page.getByTestId("order-line-cases")).toHaveValue("2");
      await expect(page.getByTestId("order-line-loose")).toHaveCount(0);
    });

    test("R2 (SA-580b): a shared code on an upb-1 product adds today's plain line (qty 1, no case/loose split)", async ({
      page,
    }) => {
      await wedgeScan(page, CODES.sharedPlain.code);
      await expect(page.getByTestId("order-line-cases")).toHaveCount(0);
      await expect(page.getByTestId("order-line-loose")).toHaveCount(0);
    });

    test("R1 on an existing line: a box then a unit code -> 1 case + 1 loose on ONE line (13 pcs)", async ({
      page,
    }) => {
      await wedgeScan(page, CODES.box.code);
      await wedgeScan(page, CODES.unit.code);
      await expect(page.getByTestId("order-line-cases")).toHaveValue("1");
      await expect(page.getByTestId("order-line-loose")).toHaveValue("1");
      await expect(page.getByTestId("order-line-pcs-total")).toContainText("13 pcs total");
    });

    test("no horizontal overflow with the loose-piece field showing", async ({ page }) => {
      await wedgeScan(page, CODES.box.code);
      await wedgeScan(page, CODES.unit.code);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
