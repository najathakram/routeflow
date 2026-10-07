/**
 * B1219 (70): a scan with NO exact code match but exactly ONE fuzzy product hit asks
 * "Did you mean <name>?" in Create Order - it never adds the product unasked.
 *   - the picker shows, no line is added
 *   - Cancel -> still no line
 *   - repeat the scan, Add -> exactly one line
 * At 1440 / 768 / 390 px.
 *
 * Role: OPERATOR (pre-authed). READ-ONLY: no customer is selected and the order is never
 * submitted, so nothing parks; the dialog is discarded at the end. The fuzzy term is DISCOVERED
 * from the tenant's own seeded products over the API (a name fragment that is not any product's
 * exact barcode/sku/unit sku and matches exactly one active product), so it needs no fixture
 * beyond the standard seed. A tenant with no such term is a FAILURE, never a skip.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SEARCH = "Search by name, SKU or scan barcode…";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

/** A name fragment with no exact code match and exactly one active fuzzy hit, plus that product. */
async function discoverFuzzyTerm(page: Page): Promise<{ term: string; name: string }> {
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const get = (path: string, params?: Record<string, string>) =>
    page.request.get(`${api}${path}`, { headers, params });

  const list = await get("/products", { limit: "100" });
  const products: any[] = ((await list.json()) as any)?.data ?? [];
  for (const p of products) {
    const name = String(p?.name ?? "");
    if (!p?.isActive || name.length < 8) continue;
    for (let at = 0; at + 6 <= name.length; at++) {
      const term = name.slice(at, at + 6).trim();
      if (term.length < 5 || /^\d{8,14}$/.test(term)) continue;
      const exact = await get(`/products/barcode/${encodeURIComponent(term)}`);
      if (exact.status() !== 404) continue;
      const res = await get("/products", {
        scanCode: term,
        limit: "20",
        includeVariants: "true",
      });
      const rows: any[] = ((await res.json()) as any)?.data ?? [];
      const lc = term.toLowerCase();
      const isExact = rows.some(
        (r) =>
          String(r.sku ?? "").toLowerCase() === lc ||
          String(r.unitSku ?? "").toLowerCase() === lc ||
          (r.barcodes ?? []).some((b: any) => String(b?.code ?? "").toLowerCase() === lc),
      );
      const sellable = rows.filter((r) => r.isActive !== false);
      if (!isExact && sellable.length === 1) return { term, name: String(sellable[0].name) };
    }
  }
  throw new Error(
    "No seeded product has a name fragment with exactly one fuzzy hit - run e2e-seed.js",
  );
}

for (const vp of VIEWPORTS) {
  test.describe(`B1219 scan "Did you mean" @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("one fuzzy hit asks first; Cancel adds nothing; Add adds one line", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      const { term, name } = await discoverFuzzyTerm(page);

      await page
        .getByRole("button", { name: /new order/i })
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible({
        timeout: 10_000,
      });
      const search = page.getByPlaceholder(SEARCH);
      const picker = page.getByRole("group", { name: /did you mean/i });
      const lines = page.getByTitle("Remove");

      async function scan() {
        await search.fill(term);
        await search.press("Enter");
        await expect(picker).toBeVisible({ timeout: 10_000 });
        await expect(picker).toContainText(`Did you mean ${name}?`);
        await expect(lines).toHaveCount(0);
      }

      await scan();
      await picker.getByRole("button", { name: "Cancel" }).click();
      await expect(picker).toBeHidden();
      await expect(lines).toHaveCount(0);

      await scan();
      await picker.getByRole("button", { name: "Add" }).click();
      await expect(picker).toBeHidden();
      await expect(lines).toHaveCount(1);

      // Nothing is submitted: remove the line and close the dialog.
      await lines.first().click();
      await page.keyboard.press("Escape");
      const discard = page.getByRole("button", { name: /discard/i });
      if (
        await discard
          .first()
          .isVisible()
          .catch(() => false)
      )
        await discard.first().click();
    });
  });
}
