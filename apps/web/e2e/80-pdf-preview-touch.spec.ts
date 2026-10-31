/**
 * W-1064 (SA-1074): a PDF preview that scrolls on a phone. R5, R6, R7, R10 and R11 on the built stack, where the worker is
 * minified and emitted and `unsafe-eval` is gone: `next dev` proves neither. Phone settings spread `devices["iPhone 13"]`
 * without `defaultBrowserType` onto Chromium, as spec 36 does, so nothing here proves iOS: R8 is a one-off on WebKit and R9
 * is the owner's phone.
 *
 * Role: OPERATOR. Tenant: the approved e2e seed. Local only: preview drafts an invoice.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const PDF_PATH = "/__e2e-three-pages.pdf";
const CUSTOMER_NAME = "E2E Fixture Deli Three";
const PRODUCT_NAME = "E2E Fixture Case Default";
const SKU = "E2E-FIX-CASEDEFAULT";
const { defaultBrowserType: _phoneBrowser, ...iPhone13 } = devices["iPhone 13"];

/** A plain three-page PDF, built here so the row needs no invoice long enough to run over. */
function threePagePdf(): Buffer {
  const pages = [4, 5, 6];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((p) => `${p} 0 R`).join(" ")}] /Count 3 >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.map(
      (_p, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${7 + i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    ),
    ...pages.map((_p, i) => {
      const text = `BT /F1 24 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
      return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
    }),
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A one-page scan: an all-white JBIG2 image, so R12 reads the request and the console, not pixels. */
function jbig2Pdf(): Buffer {
  const SIZE = 300;
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const segment = (num: number, type: number, data: number[]) => [
    ...u32(num),
    type,
    0,
    1,
    ...u32(data.length),
    ...data,
  ];
  const info = [...u32(SIZE), ...u32(SIZE), ...u32(0), ...u32(0), 0, 0, 0];
  const mmr = [...new Array<number>(Math.ceil(SIZE / 8)).fill(0xff), 0x00, 0x10, 0x01];
  const region = [...u32(SIZE), ...u32(SIZE), ...u32(0), ...u32(0), 0, 1, ...mmr];
  const image = [...segment(0, 48, info), ...segment(1, 38, region)];
  const content = `${SIZE} 0 0 ${SIZE} 0 0 cm /Im0 Do\n`;
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (b: string | number[]) => {
    const buffer = typeof b === "string" ? Buffer.from(b, "latin1") : Buffer.from(b);
    chunks.push(buffer);
    at += buffer.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = at;
    put(`${n} 0 obj\n`);
    body();
    put("\nendobj\n");
  };
  put("%PDF-1.5\n");
  obj(1, () => put("<</Type/Catalog/Pages 2 0 R>>"));
  obj(2, () => put("<</Type/Pages/Kids[3 0 R]/Count 1>>"));
  obj(3, () =>
    put(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${SIZE} ${SIZE}]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>`,
    ),
  );
  obj(4, () => {
    put(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  });
  obj(5, () => {
    put(
      `<</Type/XObject/Subtype/Image/Width ${SIZE}/Height ${SIZE}/BitsPerComponent 1/ColorSpace/DeviceGray/Filter/JBIG2Decode/Length ${image.length}>>\nstream\n`,
    );
    put(image);
    put("\nendstream");
  });
  const xref = at;
  put("xref\n0 6\n0000000000 65535 f \n");
  for (let n = 1; n <= 5; n += 1) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

const servePdf = (page: Page) =>
  page.route(`**${PDF_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/pdf", body: threePagePdf() }),
  );

function cspErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /content security policy/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function openInvoicePreview(page: Page) {
  await page.goto("/invoices/new");
  // Preview exists only outside sale mode.
  await page.getByRole("button", { name: /other charge/i }).click();
  await page.getByPlaceholder(/search customers/i).click();
  await page.getByPlaceholder(/search customers/i).fill(CUSTOMER_NAME);
  await page.getByText(CUSTOMER_NAME, { exact: true }).first().click();
  await page.getByPlaceholder(/scan barcode, or type product name/i).fill(PRODUCT_NAME);
  await page
    .getByRole("listbox")
    .getByRole("option", { name: new RegExp(SKU, "i") })
    .click();
  await page.getByRole("button", { name: /^preview$/i }).click();
}

const pointInvoicePdfAtFixture = (page: Page) =>
  page.route("**/invoices/*/pdf*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, url: `${BASE}${PDF_PATH}` } });
  });

// On a built stack `public/sw.js` answers first, so `page.route` never sees the request.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ context }) => {
  await setTenantCookie(context, BASE);
});

test.describe("touch", () => {
  test.use({ ...iPhone13 });

  test("R5: the invoice preview reaches page 3, the worker loads, and CSP stays quiet", async ({
    page,
  }) => {
    const errors = cspErrors(page);
    await servePdf(page);
    await pointInvoicePdfAtFixture(page);
    const worker = page.waitForResponse(/pdf\.worker[^/]*\.mjs/);
    await openInvoicePreview(page);
    const answer = await worker;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["content-type"]).toMatch(/javascript/);

    const scroller = page.getByLabel("Invoice preview");
    await expect(scroller.locator("canvas")).toHaveCount(3, { timeout: 20_000 });
    const reached = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop > 0 && el.scrollHeight > el.clientHeight;
    });
    expect(reached).toBe(true);
    await expect(scroller.locator("canvas").nth(2)).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test("P7: both modal buttons sit on screen at 44 px on a phone", async ({ page }) => {
    await servePdf(page);
    await pointInvoicePdfAtFixture(page);
    await openInvoicePreview(page);
    for (const name of ["Close", "Send invoice"]) {
      const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
  });

  test("R6: a real invoice draws, and the screenshot is kept to read its figures", async ({
    page,
  }, testInfo) => {
    await openInvoicePreview(page);
    const scroller = page.getByLabel("Invoice preview");
    await expect(scroller.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
    await testInfo.attach("invoice-preview-phone", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("R10: a customer's PDF draws, or says so with Download, never blank", async ({
    page,
    request,
  }) => {
    await servePdf(page);
    await page.goto("/customers");
    const token = await operatorAccessToken(page);
    const list = await request.get(
      `${apiBase(page.url())}/api/v1/customers?search=${encodeURIComponent(CUSTOMER_NAME)}`,
      { headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG } },
    );
    const body = await list.json();
    const customer = (body.data ?? body)[0] as { id: string };
    await page.route(`**/customers/${customer.id}/documents*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "doc-1",
            originalName: "agreement.pdf",
            mimeType: "application/pdf",
            docType: "OTHER",
            url: `${BASE}${PDF_PATH}`,
            sizeBytes: 900,
            createdAt: "2026-10-31T00:00:00.000Z",
          },
        ]),
      }),
    );
    await page.goto(`/customers/${customer.id}`);
    await page.getByRole("tab", { name: /documents/i }).click();
    await page.getByText("agreement.pdf").first().click();
    await expect(
      page
        .locator("[role=dialog] canvas")
        .first()
        .or(page.getByText("Preview isn't available here.")),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("R12: a JBIG2 scan loads its JavaScript decoder and decodes", async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (m) => warnings.push(m.text()));
    const errors = cspErrors(page);
    await page.route("**/vendor-bills/scan-invoice", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ items: [], subtotal: 0, tax: 0, total: 0 }),
      }),
    );
    const decoder = page.waitForResponse(/\/pdfjs\/jbig2_nowasm_fallback\.js/);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: jbig2Pdf() });
    const answer = await decoder;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["content-type"]).toMatch(/javascript/);
    await expect(page.getByLabel("Invoice PDF").locator("canvas").first()).toBeVisible({
      timeout: 20_000,
    });
    expect(warnings.filter((w) => /unable to decode image/i.test(w))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("R13: the scan modal's Next draws the next invoice's own file", async ({ page }) => {
    await page.route("**/vendor-bills/scan-invoice", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ items: [], subtotal: 0, tax: 0, total: 0 }),
      }),
    );
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "three-pages.pdf", mimeType: "application/pdf", buffer: threePagePdf() },
      { name: "one-page.pdf", mimeType: "application/pdf", buffer: jbig2Pdf() },
    ]);
    const canvases = page.getByLabel("Invoice PDF").locator("canvas");
    await expect(canvases).toHaveCount(3, { timeout: 20_000 });
    await page.getByTitle("Next invoice").click();
    await expect(canvases).toHaveCount(1, { timeout: 20_000 });
  });

  test("R11: the scan modal draws a PDF on canvas", async ({ page }) => {
    await page.route("**/vendor-bills/scan-invoice", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          supplier: "E2E Wholesale Co",
          invoiceNumber: "INV-E2E-1",
          invoiceDate: "2026-07-01",
          expenseDescription: null,
          expenseCategory: null,
          subtotal: 70,
          tax: 0,
          total: 70,
          notes: null,
          items: [],
        }),
      }),
    );
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: threePagePdf() });
    await expect(page.getByLabel("Invoice PDF").locator("canvas").first()).toBeVisible({
      timeout: 20_000,
    });
  });
});

test("R7: desktop keeps its iframe and never asks for the worker", async ({ page }) => {
  let workerAsked = false;
  page.on("request", (r) => {
    if (/pdf\.worker/.test(r.url())) workerAsked = true;
  });
  await servePdf(page);
  await pointInvoicePdfAtFixture(page);
  await openInvoicePreview(page);
  await expect(page.locator('iframe[title="Invoice preview"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Invoice preview").locator("canvas")).toHaveCount(0);
  expect(workerAsked).toBe(false);
});
