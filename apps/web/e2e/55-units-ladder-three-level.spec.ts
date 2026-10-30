/**
 * I-101 item 6 (units ladder matrix 2026-10-28, A6): the three-level ladder through the web app, order -> invoice at Case
 * and at Pallet.
 *
 * Fixture, built by THIS spec through the real API (never the seed, never raw rows): one family with two variants, each a
 * 10-piece pack (`unitsPerBox` 10, box $20.00 and $30.00). On each variant the real units writer (POST /products/:id/units)
 * adds Case = 200 pieces (perParent 20) and Pallet = 4,800 pieces (parentUnitId = the Case, perParent 24).
 *
 * Expected values are the ladder arithmetic, written down here: a Case is 20 x the box price, a Pallet is 24 x the Case price.
 * For two units of a level, the stored order and invoice lines are boxes 2, qty 2 x factor (pieces), unitsPerBox = factor,
 * unitPrice = level price, subtotal = 2 x level price; the order and invoice detail pages read "2 Cases" / "2 Pallets".
 *
 * Residue: one family, two variants, and a PENDING order and an invoice per level on the approved e2e tenant, the same
 * no-cleanup tolerance 53 and 54 take (orders and invoices have no API delete). Names carry a per-run suffix.
 * A tenant not served `flag.units_v1`, or missing the customer fixture, is a HARD FAILURE, never a skip.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const CUSTOMER_NAME = "E2E Fixture Deli Three";
const SEED_HINT =
  "`node apps/api/scripts/e2e-seed.js` seeds the customer fixture - run it, then re-run.";
const RUN = Date.now().toString(36);

const VARIANTS = [
  { key: "a1", box: "20.00", casePrice: 400, palletPrice: 9600 },
  { key: "a2", box: "30.00", casePrice: 600, palletPrice: 14400 },
] as const;
const LEVELS = [
  { label: "Case", plural: "Cases", factor: 200 },
  { label: "Pallet", plural: "Pallets", factor: 4800 },
] as const;
const COUNT = 2;

interface Ctx {
  api: string;
  headers: { authorization: string; "x-tenant-slug": string };
}
interface Built {
  customerId: string;
  /** variant key -> product id and name */
  variants: Record<string, { id: string; name: string }>;
}

async function apiCtx(page: Page): Promise<Ctx> {
  await page.goto("/orders");
  await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
  const token = await operatorAccessToken(page);
  expect(token, "no operator access token - operator storageState is stale").toBeTruthy();
  return {
    api: `${apiBase(page.url())}/api/v1`,
    headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
  };
}

/** One family, two 10-piece variants, each with Case and Pallet written through the units endpoint. */
async function buildFixture(page: Page, ctx: Ctx): Promise<Built> {
  const customerRes = await page.request.get(
    `${ctx.api}/customers?search=${encodeURIComponent(CUSTOMER_NAME)}`,
    { headers: ctx.headers },
  );
  expect(customerRes.ok(), `GET /customers returned ${customerRes.status()}`).toBe(true);
  const body = await customerRes.json();
  const rows = (body.data ?? body.customers ?? body) as Array<{
    id: string;
    businessName?: string;
  }>;
  const customer = rows.find?.((c) => c.businessName === CUSTOMER_NAME);
  expect(customer, `Fixture customer "${CUSTOMER_NAME}" not found - ${SEED_HINT}`).toBeTruthy();

  const made = await page.request.post(`${ctx.api}/products/families`, {
    headers: ctx.headers,
    data: {
      family: { name: `E2E I101 Family ${RUN}`, pricePerUnit: "20.00" },
      variants: VARIANTS.map((v) => ({
        name: `E2E I101 ${RUN} ${v.key}`,
        pricePerUnit: v.box,
        unitsPerBox: 10,
      })),
    },
  });
  expect(made.ok(), `POST /products/families returned ${made.status()}`).toBe(true);
  const created = (await made.json()) as { variants: Array<{ id: string; name: string }> };

  const variants: Built["variants"] = {};
  for (const v of VARIANTS) {
    const row = created.variants.find((c) => c.name === `E2E I101 ${RUN} ${v.key}`);
    expect(row, `variant ${v.key} missing from the family response`).toBeTruthy();
    variants[v.key] = { id: row!.id, name: row!.name };

    const caseRes = await page.request.post(`${ctx.api}/products/${row!.id}/units`, {
      headers: ctx.headers,
      data: { label: "Case", factorToBase: 200, perParent: 20 },
    });
    expect(caseRes.ok(), `POST Case returned ${caseRes.status()}: ${await caseRes.text()}`).toBe(
      true,
    );
    const caseRow = (await caseRes.json()) as { id: string };
    const palletRes = await page.request.post(`${ctx.api}/products/${row!.id}/units`, {
      headers: ctx.headers,
      data: { label: "Pallet", factorToBase: 4800, parentUnitId: caseRow.id, perParent: 24 },
    });
    expect(
      palletRes.ok(),
      `POST Pallet returned ${palletRes.status()}: ${await palletRes.text()}`,
    ).toBe(true);
  }
  return { customerId: customer!.id, variants };
}

test.describe("Units ladder 10 / 200 / 4800 - order -> invoice at Case and Pallet (I-101 item 6)", () => {
  test.describe.configure({ mode: "serial" });
  let built: Built;
  let ctx: Ctx;

  test("fixture: one family, two 10-piece variants, Case and Pallet written through the units endpoint", async ({
    page,
    context,
  }) => {
    await setTenantCookie(context, BASE);
    ctx = await apiCtx(page);
    built = await buildFixture(page, ctx);
  });

  for (const v of VARIANTS) {
    for (const l of LEVELS) {
      test(`${v.key}: ${COUNT} ${l.plural} are stored in pieces, priced from the ladder, and read the same on the order and the invoice`, async ({
        page,
        context,
        request,
      }) => {
        await setTenantCookie(context, BASE);
        const live = await apiCtx(page);
        const variant = built.variants[v.key];
        const price = l.label === "Case" ? v.casePrice : v.palletPrice;

        const orderRes = await request.post(`${live.api}/orders`, {
          headers: live.headers,
          data: {
            customerId: built.customerId,
            status: "PENDING",
            forceNew: true,
            items: [{ productId: variant.id, qty: COUNT, unitLabel: l.label }],
          },
        });
        expect(
          orderRes.ok(),
          `POST /orders returned ${orderRes.status()}: ${await orderRes.text()}`,
        ).toBe(true);
        const order = (await orderRes.json()) as { id: string; orderNumber: string };
        const readRes = await request.get(`${live.api}/orders/${order.id}`, {
          headers: live.headers,
        });
        expect(readRes.ok(), `GET /orders/:id returned ${readRes.status()}`).toBe(true);
        const read = (await readRes.json()) as {
          lineItems: Array<{
            productId: string | null;
            unitLabel?: string | null;
            boxes?: number | null;
            qty: number | string;
            unitsPerBox?: number | null;
            unitPrice: number | string;
            subtotal: number | string;
          }>;
        };
        const line = read.lineItems.find((li) => li.productId === variant.id);
        expect(line, "order carries no line for the variant").toBeTruthy();
        expect({
          unitLabel: line!.unitLabel,
          boxes: Number(line!.boxes),
          qty: Number(line!.qty),
          unitsPerBox: Number(line!.unitsPerBox),
          unitPrice: Number(line!.unitPrice),
          subtotal: Number(line!.subtotal),
        }).toEqual({
          unitLabel: l.label,
          boxes: COUNT,
          qty: COUNT * l.factor,
          unitsPerBox: l.factor,
          unitPrice: price,
          subtotal: COUNT * price,
        });

        await page.goto(`/orders/${order.id}`);
        const main = page.locator("#main-content");
        await expect(main.getByText(variant.name, { exact: true }).first()).toBeVisible({
          timeout: 15_000,
        });
        await expect(main.getByText(new RegExp(`\\b${COUNT} ${l.plural}\\b`)).first()).toBeVisible({
          timeout: 10_000,
        });

        const invoiceRes = await request.post(`${live.api}/invoices/from-order/${order.id}`, {
          headers: live.headers,
        });
        expect(
          invoiceRes.ok(),
          `POST /invoices/from-order returned ${invoiceRes.status()}: ${await invoiceRes.text()}`,
        ).toBe(true);
        const invoiceBody = await invoiceRes.json();
        const invoice = (Array.isArray(invoiceBody) ? invoiceBody[0] : invoiceBody) as {
          id: string;
          invoiceNumber: string;
        };
        await page.goto(`/invoices/${invoice.id}`);
        await expect(
          page
            .locator("#main-content")
            .getByRole("heading", { name: invoice.invoiceNumber })
            .first(),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          page.locator("#main-content").getByText(variant.name, { exact: true }).first(),
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          page
            .locator("#main-content")
            .getByText(new RegExp(`\\b${COUNT} ${l.plural}\\b`))
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      });
    }
  }
});
