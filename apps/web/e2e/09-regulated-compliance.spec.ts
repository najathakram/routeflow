/**
 * Regulated compliance smoke — the report panel on /compliance/[categoryId].
 *
 * First e2e coverage of any regulated surface. Exercises the WP10/WP11 report-UX
 * work: the DateRangePicker (preset rail + two-click range selection), the
 * ReportColumnsPicker (materialize-then-toggle, custom-layout persistence, reset
 * round-trip), the `columns` query param on previews, and the Prepare-filing
 * button's relocation into the Filings card.
 *
 * Every regulated/tracked-categories endpoint is MOCKED (same pattern as
 * `mockSuppliers` in 02-operator.spec.ts), so the suite is deterministic, leaves
 * no residue in any tenant, and works against prod or a local stack alike.
 * Saved-layout PATCHes are captured and asserted — nothing is ever written.
 *
 * Deploy-order guard: when the deployed web build predates this feature the
 * panel has no Columns button — every test skips (never fails) so the nightly
 * stays green until the web deploy lands.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const CAT_ID = "e2e-reg-cat-1";

// ─── Fixtures (mirror apps/api/src/regulated/template-registry.ts) ────────────

const TX_COLUMNS = [
  { key: "wholesalerPermit", label: "Wholesaler Permit #", default: true },
  { key: "retailerTaxpayerId", label: "Retailer Taxpayer ID", default: true },
  { key: "retailerName", label: "Retailer Name", default: true },
  { key: "retailerStreet", label: "Retailer Street Address", default: true },
  { key: "retailerCity", label: "Retailer City", default: true },
  { key: "state", label: "State", default: true },
  { key: "zip", label: "ZIP", default: true },
  { key: "retailerPermit", label: "Retailer Permit #", default: true },
  { key: "itemType", label: "Item Type", default: true },
  { key: "uom", label: "Unit of Measure", default: true },
  { key: "quantity", label: "Quantity", align: "right", default: true },
  { key: "invoiceAmount", label: "Invoice Amount", align: "right", default: true },
  { key: "itemDescription", label: "Item Description", default: false },
  { key: "invoiceNumber", label: "Invoice #", default: false },
  { key: "invoiceDate", label: "Invoice Date", default: false },
];
const TX_DEFAULT_KEYS = TX_COLUMNS.filter((c) => c.default).map((c) => c.key);
const CUSTOM_13_KEYS = [...TX_DEFAULT_KEYS, "itemDescription"];

const TEMPLATES = [
  {
    key: "TX_COMPTROLLER",
    label: "TX Comptroller",
    kind: "per-sale",
    productConfig: {
      itemTypes: [
        {
          code: "1",
          label: "Cigarettes",
          uoms: [
            { code: "CP", label: "CP — Packs" },
            { code: "CS", label: "CS — Sticks" },
            { code: "CC", label: "CC — Cartons" },
          ],
        },
      ],
      caseUomSupported: true,
    },
    columns: TX_COLUMNS,
  },
  {
    key: "GENERIC",
    label: "Generic",
    kind: "aggregate",
    productConfig: null,
    columns: [
      { key: "period", label: "Period", default: true },
      { key: "qty", label: "Qty", align: "right", default: true },
      { key: "unitBasisQty", label: "Unit Basis Qty", align: "right", default: true },
      { key: "netSales", label: "Net Sales", align: "right", default: true },
      { key: "categoryTax", label: "Category Tax", align: "right", default: true },
    ],
  },
];

function categoryFixture(prefs: Record<string, string[]> | null) {
  return {
    id: CAT_ID,
    name: "E2E Tobacco",
    taxType: "NONE",
    rate: "0",
    unitBasis: null,
    priceIncludesTax: false,
    invoiceTreatment: "SEPARATE_INVOICE",
    appliesScope: null,
    requiresLicense: false,
    reportTemplate: "TX_COMPTROLLER",
    reportCadence: "MONTHLY",
    active: true,
    productCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    wholesalerLicenseNo: null,
    txItemType: null,
    txUom: null,
    reportColumnPrefs: prefs,
  };
}

// ─── Mock plumbing ────────────────────────────────────────────────────────────

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

/**
 * Installs mocks for every endpoint the compliance section page touches, and
 * captures PATCH bodies so column-layout saves can be asserted without writing
 * anywhere. `prefs` seeds the category's stored reportColumnPrefs.
 */
async function mockRegulatedApi(page: Page, prefs: Record<string, string[]> | null = null) {
  const patches: Array<Record<string, unknown>> = [];
  let category = categoryFixture(prefs);

  await page.route(/\/tracked-categories\/e2e-reg-cat-1\/subcategories(\?.*)?$/, (route) =>
    fulfillJson(route, []),
  );
  await page.route(/\/tracked-categories\/e2e-reg-cat-1(\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      category = { ...category, ...(body as Partial<typeof category>) };
      return fulfillJson(route, category);
    }
    return fulfillJson(route, category);
  });
  await page.route(/\/regulated\/templates(\?.*)?$/, (route) => fulfillJson(route, TEMPLATES));
  await page.route(/\/regulated\/filings(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/regulated\/ledger(\?.*)?$/, (route) =>
    fulfillJson(route, { rows: [], totals: { qty: 0, netSales: 0, categoryTax: 0 } }),
  );
  await page.route(/\/tenants\/me\/addons(\?.*)?$/, (route) =>
    fulfillJson(route, { addons: ["tobacco_dealer"] }),
  );
  return { patches };
}

/**
 * Navigate to the mocked section page. Returns false (→ caller skips) when the
 * deployed build predates the report-panel UX — detected by the absence of the
 * Columns picker, which only the new panel renders.
 */
async function gotoPanel(page: Page): Promise<boolean> {
  await page.goto(`/compliance/${CAT_ID}`);
  return page
    .getByRole("button", { name: /^Columns \(\d+\)$/ })
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

const SKIP_REASON = "regulated report-panel UX not present in this web build (pre-deploy)";

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Regulated compliance — report panel", () => {
  test("panel renders with Prepare filing inside the Filings card, not the page header", async ({
    page,
  }) => {
    await mockRegulatedApi(page);
    test.skip(!(await gotoPanel(page)), SKIP_REASON);

    // Template select is registry-fed, with the category default pre-selected.
    // (The Template <label> is not htmlFor-associated, so the select has no
    // accessible name — assert on its selected option instead.)
    //
    // The copy is `{templateLabel(categoryDefaultTemplate)} default` — see
    // components/RegulatedReportPanel.tsx. It was "Category default (TX_COMPTROLLER)"
    // until #474 renamed the TX_COMPTROLLER template labels; this assertion was not
    // updated with it and had been failing on every master E2E run since.
    // Matched loosely so a further label tweak does not re-break it: what this test
    // exists to pin is that the CATEGORY DEFAULT is the pre-selected option.
    await expect(page.locator("select").first().locator("option:checked")).toHaveText(
      /Texas Comptroller\s+default/i,
    );

    // Official TX default layout → 12 columns.
    await expect(page.getByRole("button", { name: "Columns (12)" })).toBeVisible();

    // "Prepare last period" lives in the Filings card (a container that also
    // holds the Filings heading), and the page banner has no prepare button.
    const prepare = page.getByRole("button", { name: "Prepare last period" });
    await expect(prepare).toBeVisible();
    const filingsCard = page
      .locator("div, section")
      .filter({ has: page.getByRole("heading", { name: "Filings" }) })
      .filter({ has: prepare });
    await expect(filingsCard.first()).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: /prepare/i })).toHaveCount(0);
  });

  test("date range picker: presets, two-month calendar, first click anchors without committing", async ({
    page,
  }) => {
    await mockRegulatedApi(page);
    test.skip(!(await gotoPanel(page)), SKIP_REASON);

    // The trigger shows the default preset label before any interaction.
    const trigger = page.getByRole("button", { name: "Last month", exact: true }).first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Preset rail + two month grids.
    for (const preset of ["This month", "Last quarter", "Year to date"]) {
      await expect(page.getByRole("button", { name: preset, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("grid")).toHaveCount(2);

    // First click of a new range anchors only — the committed value (and the
    // trigger label) must not change until the second click completes the range.
    const leftGrid = page.getByRole("grid").first();
    await leftGrid.getByRole("button", { name: /\b15th\b/ }).click();
    await expect(
      page.getByRole("button", { name: "Last month", exact: true }).first(),
    ).toBeVisible();

    // Second click commits the ordered range; the trigger reflects both ends.
    await leftGrid.getByRole("button", { name: /\b20th\b/ }).click();
    const committed = page.getByRole("button", { name: /^\w{3} 15, \d{4} – \w{3} 20, \d{4}$/ });
    await expect(committed).toBeVisible();

    // Escape closes the popover.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("grid")).toHaveCount(0);
  });

  test("columns picker: materialize-then-toggle and custom-layout save", async ({ page }) => {
    const { patches } = await mockRegulatedApi(page);
    test.skip(!(await gotoPanel(page)), SKIP_REASON);

    await page.getByRole("button", { name: "Columns (12)" }).click();

    // Toggling one optional column materializes the 12 defaults and adds it —
    // no other column resets.
    await page.getByLabel(/Item Description/).check();
    await expect(page.getByRole("button", { name: "Columns (13)" })).toBeVisible();
    await expect(page.getByLabel(/Wholesaler Permit #/)).toBeChecked();
    await expect(page.locator("input[type=checkbox]:checked")).toHaveCount(CUSTOM_13_KEYS.length);

    // The custom layout is flagged in the template select (asserted via its
    // selected option — the select has no accessible name, see the first test).
    await expect(page.locator("select").first().locator("option:checked")).toHaveText(
      "Custom (based on TX Comptroller)",
    );

    // Saving persists the full 13-key layout under the template's key.
    await page.getByRole("button", { name: "Save for this section" }).click();
    await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1);
    const saved = patches[0].reportColumnPrefs as Record<string, string[]>;
    expect(saved.TX_COMPTROLLER).toEqual(CUSTOM_13_KEYS);
  });

  test("reset to template keeps Save visible and clears the stored layout", async ({ page }) => {
    // Category starts WITH a saved custom layout for this template.
    const { patches } = await mockRegulatedApi(page, { TX_COMPTROLLER: CUSTOM_13_KEYS });
    test.skip(!(await gotoPanel(page)), SKIP_REASON);

    // The stored custom layout is live on load.
    await page.getByRole("button", { name: "Columns (13)" }).click();

    // Reset flips the selection back to the template default…
    await page.getByRole("button", { name: "Reset to template" }).click();
    await expect(page.getByRole("button", { name: "Columns (12)" })).toBeVisible();

    // …and Save MUST survive the reset so the reverted state can be persisted
    // (regression guard: the button used to vanish, making reset unsaveable).
    const save = page.getByRole("button", { name: "Save for this section" });
    await expect(save).toBeVisible();
    await save.click();

    // Removing the only template key clears the column entirely (null, not {}).
    await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1);
    expect(patches[0].reportColumnPrefs).toBeNull();
  });

  test("preview request carries the custom columns param and renders the projection", async ({
    page,
  }) => {
    await mockRegulatedApi(page);
    test.skip(!(await gotoPanel(page)), SKIP_REASON);

    const previewUrls: string[] = [];
    await page.route(/\/regulated\/reports\/preview(\?.*)?$/, (route) => {
      previewUrls.push(route.request().url());
      return fulfillJson(route, {
        template: "TX_COMPTROLLER",
        title: "Texas Comptroller Cigarette/Tobacco Report",
        categoryId: CAT_ID,
        categoryName: "E2E Tobacco",
        from: "2026-06-01",
        to: "2026-06-30",
        columns: [
          { key: "retailerName", label: "Retailer Name" },
          { key: "itemDescription", label: "Item Description" },
          { key: "quantity", label: "Quantity", align: "right" },
        ],
        rows: [["Acme Corner Store", "Acme cigarettes (boxed)", "12"]],
        totalsRow: null,
        displayTotals: [{ label: "Rows", value: "1" }],
        warnings: [],
        custom: true,
      });
    });

    // Build a custom layout, then preview.
    await page.getByRole("button", { name: "Columns (12)" }).click();
    await page.getByLabel(/Item Description/).check();
    await page.getByRole("button", { name: "Preview", exact: true }).click();

    // The request must carry a local-ISO range and the ordered columns list.
    await expect.poll(() => previewUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const url = new URL(previewUrls[0]);
    expect(url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("columns")).toBe(CUSTOM_13_KEYS.join(","));

    // The projected preview renders the mocked report: custom columns as
    // headers, the row's cells, and the custom-layout notice.
    await expect(page.getByRole("columnheader", { name: "Item Description" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Acme cigarettes (boxed)" })).toBeVisible();
    await expect(page.getByText(/custom column layout/i)).toBeVisible();
  });
});
