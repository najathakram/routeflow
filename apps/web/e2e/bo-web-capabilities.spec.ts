/**
 * BO-05: "What this business does", the capability checkboxes on the Backoffice tenant Setup tab, proved at 1440, 768
 * and 390.
 *
 * NOT RUN by the author (no stack in the build worktree): written for `npm run local:up` + `npm run local:seed`, with
 * the local super-admin session the other `bo-web-*` specs use. Approved tenants only: `test` or a throwaway `qa-*`
 * slug, never a live tenant. The spec only PREVIEWS; it asserts that no write request is ever sent, so it changes
 * nothing on the tenant it visits.
 *
 * `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset, so a forgotten variable can never point
 * this spec at a real site.
 */
import { test, expect, type Page, type Request } from "@playwright/test";

function baseUrl(): string {
  const value = process.env.PLAYWRIGHT_BASE_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "PLAYWRIGHT_BASE_URL is not set. Point it at the local stack (http://localhost:3001); there is no default.",
    );
  }
  return value;
}

test.use({ baseURL: baseUrl() });

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

const APPROVED_SLUG = /^(test|qa-[a-z0-9-]+)$/;

/** The id of the first listed approved test tenant; fails loudly rather than touching any other tenant. */
async function approvedTenantId(page: Page): Promise<string> {
  await page.goto("/admin/tenants");
  const links = page.locator('a[href^="/admin/tenants/"]');
  await expect(links.first()).toBeVisible({ timeout: 15_000 });
  const count = await links.count();
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const text = ((await link.textContent()) ?? "").trim();
    if (!APPROVED_SLUG.test(text)) continue;
    const id = (await link.getAttribute("href"))?.split("/")[3]?.split("?")[0];
    if (id) return id;
  }
  throw new Error(
    "No approved test tenant (test or qa-*) is listed; seed one before running this spec.",
  );
}

async function openSetup(page: Page): Promise<void> {
  const id = await approvedTenantId(page);
  await page.goto(`/admin/tenants/${id}?tab=setup`);
  await expect(page.getByRole("group", { name: "What this business does" })).toBeVisible({
    timeout: 15_000,
  });
}

/** Every request that could write: anything but a GET, a preview POST or the CORS preflight. */
function trackWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (req) => {
    const method = req.method();
    if (method === "GET" || method === "OPTIONS" || method === "HEAD") return;
    if (/\/business-capabilities\/preview$/.test(req.url())) return;
    writes.push(req);
  });
  return writes;
}

for (const size of WIDTHS) {
  test.describe(`BO-05 at ${size.width}`, () => {
    test.use({ viewport: size });

    test("every checkbox row and the Start from… button are at least 44 px tall, with no sideways scroll", async ({
      page,
    }) => {
      await openSetup(page);
      const rows = page.locator(
        "fieldset[data-focus-target='capabilities'] label:has(input[type=checkbox])",
      );
      expect(await rows.count()).toBe(4);
      for (let i = 0; i < 4; i++) {
        const box = await rows.nth(i).boundingBox();
        expect(box!.height, `checkbox row ${i}`).toBeGreaterThanOrEqual(44);
      }
      const start = page.getByRole("button", { name: "Start from…" });
      expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await start.click();
      const items = page.getByRole("menuitem");
      expect(await items.count()).toBe(7);
      for (let i = 0; i < 7; i++) {
        expect((await items.nth(i).boundingBox())!.height, `preset ${i}`).toBeGreaterThanOrEqual(
          44,
        );
      }
      const menu = await page.getByRole("menu").boundingBox();
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(size.width + 1);
      await page.keyboard.press("Escape");

      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main") as HTMLElement;
        return { scroll: main.scrollWidth, client: main.clientWidth };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    });

    test("ticking Delivery + Shipping previews inline, fits, and writes nothing", async ({
      page,
    }) => {
      const writes = trackWrites(page);
      await openSetup(page);
      const delivery = page.getByRole("checkbox", { name: "Delivers on own trucks" });
      const shipping = page.getByRole("checkbox", { name: "Ships by carrier" });
      test.skip(
        (await delivery.isChecked()) && (await shipping.isChecked()),
        "the tenant is already Delivery + shipping; reseed it before running this check",
      );
      if (!(await delivery.isChecked())) await delivery.check();
      if (!(await shipping.isChecked())) await shipping.check();

      const preview = page.getByTestId("capability-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute("aria-busy", "false", { timeout: 10_000 });
      await expect(preview).toContainText("Delivery and shipping");
      await expect(
        page.getByRole("button", { name: /^(Apply|Stop billing and apply)$/ }),
      ).toBeEnabled();

      // the preview fits the viewport, beside the controls at 1440 and stacked below them at 768 and 390
      const panel = (await preview.boundingBox())!;
      const fieldset = (await page
        .locator("fieldset[data-focus-target='capabilities']")
        .boundingBox())!;
      expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
      if (size.width >= 1024)
        expect(panel.x).toBeGreaterThanOrEqual(fieldset.x + fieldset.width - 1);
      else expect(panel.y).toBeGreaterThanOrEqual(fieldset.y + fieldset.height - 1);

      // the actions are the full width of the card at 390
      if (size.width <= 390) {
        const apply = (await page
          .getByRole("button", { name: /^(Apply|Stop billing and apply)$/ })
          .boundingBox())!;
        expect(apply.width).toBeGreaterThan(size.width * 0.6);
      }

      // nothing was ever written: only the preview was asked for
      expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
    });

    test("a nothing-ticked draft says why Apply is off", async ({ page }) => {
      const writes = trackWrites(page);
      await openSetup(page);
      for (const name of ["Delivers on own trucks", "Ships by carrier", "Sells at the counter"]) {
        const box = page.getByRole("checkbox", { name });
        if (await box.isChecked()) await box.uncheck();
      }
      await expect(page.getByText("Tick at least one.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Apply|Stop billing and apply)$/ }),
      ).toBeDisabled();
      expect(writes).toHaveLength(0);
    });
  });
}
