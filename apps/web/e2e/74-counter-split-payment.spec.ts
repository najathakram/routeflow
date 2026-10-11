/**
 * Split payment at the counter (74), to the UX lane's G7 brief.
 *   scan one product -> "Split payment" grows in place (Card, then Cash) -> the focused leg input never sits under the sticky
 *   checkout bar -> Card + Cash over-pay reads "Change $10.00" -> Complete -> the receipt lists Card / Cash / Change ->
 *   Today's sales reads "Card $x + Cash $y" (cash applied, net of change).
 * Layout at 390 (one column) and 1440 (two columns): 0 px overlap of the focused leg input with `counter-checkout-bar`, and
 * at most 4 taps from the cart to Complete.
 *
 * LOCAL LANE ONLY, same guards as 71 / 72: the tenant is put on the in_store_shipping_retailer profile (counter on) via
 * helpers/local-fulfilment-profile.ts and restored row-for-row in afterAll. The layout tests write NOTHING (they stop before
 * Complete). The ring test rings ONE real counter sale on the approved test tenant at 1440 (like 72). Products are DISCOVERED
 * over the API. Needs `npm run local:sa` and an API that serves the split contract (`payments` legs).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import {
  applyBusinessProfile,
  localTarget,
  readApiCapability,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  type FulfilmentSnapshot,
  waitForApiCapability,
} from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const COUNTER = "/orders/counter-sale";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
const target = () => localTarget(apiBase(BASE));

test.beforeAll(async () => {
  before = await snapshotFulfilmentConfig(target());
  capabilityBefore = await readApiCapability(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (!before) return;
  const restored = await restoreFulfilmentConfig(target(), before);
  expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
  await waitForApiCapability(target(), capabilityBefore, 60_000);
});

async function discoverSku(page: Page): Promise<string> {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const res = await page.request.get(`${api}/products`, { headers, params: { limit: "50" } });
  const products: any[] = ((await res.json()) as any)?.data ?? [];
  const p = products.find(
    (x) => x?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(x?.sku ?? "")),
  );
  expect(p, "the tenant needs an active product with a SKU").toBeTruthy();
  return String(p.sku);
}

/** One product on the cart; returns the sale total in integer cents (read from the running total, never computed here). */
async function ringOne(page: Page, sku: string): Promise<number> {
  await page.goto(COUNTER);
  const scanField = page.getByLabel("Scan or search items");
  await expect(scanField).toBeVisible({ timeout: 15_000 });
  await scanField.fill(sku);
  await scanField.press("Enter");
  await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
    timeout: 15_000,
  });
  // the line's price resolves a beat after the row mounts: wait for a non-zero total before reading it
  await expect(page.getByTestId("running-total")).not.toContainText(/\$0\.00/, { timeout: 15_000 });
  const text = (await page.getByTestId("running-total").textContent()) ?? "";
  const m = /\$(\d+)\.(\d{2})/.exec(text.replace(/,/g, ""));
  expect(m, `a total like $12.34 in "${text}"`).toBeTruthy();
  return Number(m![1]) * 100 + Number(m![2]);
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const plain = (cents: number) => (cents / 100).toFixed(2);

/** Vertical overlap in px between two boxes (0 = they do not overlap). */
async function overlapPx(a: Locator, b: Locator): Promise<number> {
  const [ra, rb] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  expect(ra, "the input has a box").toBeTruthy();
  expect(rb, "the bar has a box").toBeTruthy();
  return Math.max(0, Math.min(ra!.y + ra!.height, rb!.y + rb!.height) - Math.max(ra!.y, rb!.y));
}

for (const vp of VIEWPORTS) {
  test.describe(`split payment layout @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("grows in place, the focused leg clears the sticky bar, and Complete is within 4 taps", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      const sku = await discoverSku(page);
      const totalCents = await ringOne(page, sku);
      const bar = page.getByTestId("counter-checkout-bar");
      let taps = 0;
      const tap = async (l: Locator) => {
        taps += 1;
        await l.click();
      };

      // 1 tap: the link is a full-width 44 px row under the method row, and the lines grow in place (no dialog)
      const link = page.getByTestId("split-payment-link");
      const lb = await link.boundingBox();
      expect(lb!.height).toBeGreaterThanOrEqual(44);
      if (vp.width <= 390) {
        // counter-payment-column is display:contents at 390 (no box): the Payment section is its box-bearing child
        const cb = await page.getByRole("region", { name: "Payment" }).boundingBox();
        expect(lb!.width).toBeGreaterThanOrEqual(cb!.width - 2); // full width of its column
      }
      await tap(link);
      await expect(page.getByTestId("split-tender-panel")).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // opened with no amounts: the bar's change-due slot reads Remaining <total>, never a dash
      await expect(page.getByTestId("change-due")).toHaveText(`Remaining ${dollars(totalCents)}`);
      await expect(page.getByTestId("split-leg-1")).toContainText("Card");
      await expect(page.getByTestId("split-leg-2")).toContainText("Cash");

      // the focused leg input overlaps the sticky bar by 0 px (scroll-margin-bottom = bar height)
      for (const n of [1, 2]) {
        const input = page.getByLabel(`Payment ${n} amount`);
        await input.focus();
        await page.waitForTimeout(250); // let the focus scroll settle
        expect(
          await overlapPx(input, bar),
          `Payment ${n} amount overlaps the checkout bar by 0 px`,
        ).toBe(0);
        const ib = await input.boundingBox();
        expect(ib!.height).toBeGreaterThanOrEqual(44);
      }

      // method buttons sit ABOVE the amount (390): the group's box ends above the input's top
      if (vp.width <= 390) {
        const g = await page.getByRole("group", { name: "Payment 1 method" }).boundingBox();
        const i = await page.getByLabel("Payment 1 amount").boundingBox();
        expect(g!.y + g!.height).toBeLessThanOrEqual(i!.y + 1);
      }

      // Card = the total less $20 (typed, no tap: the first amount took the cursor), then Cash Exact (tap 2)
      if (totalCents > 2000) {
        await page.getByLabel("Payment 1 amount").fill(plain(totalCents - 2000));
        await tap(page.getByRole("button", { name: "Cash Exact" }));
      } else {
        await page.getByLabel("Payment 1 amount").fill(plain(totalCents));
      }
      await expect(page.getByTestId("change-due")).toHaveText("Change $0.00");
      const completeBtn = page.getByRole("button", { name: "Complete & show receipt" });
      await expect(completeBtn).toBeEnabled();
      taps += 1; // Complete itself is the last tap; the test stops BEFORE it so nothing is written
      expect(taps, "cart -> Complete in at most 4 taps").toBeLessThanOrEqual(4);

      // Card 80 on the total is refused inline with the brief's line, and Complete stays off (0 POSTs)
      let posts = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && /\/orders\/counter-sale(\?|$)/.test(r.url())) posts += 1;
      });
      await page.getByLabel("Payment 1 amount").fill(plain(totalCents + 1000));
      await expect(page.getByTestId("split-issue-1")).toHaveText(
        "Card and check can't be more than the total.",
      );
      await expect(completeBtn).toBeDisabled();
      expect(posts, "no POST was sent").toBe(0);

      // no horizontal overflow
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("split payment: ring one sale @ 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Card + Cash over-pay: Change $10.00, receipt Card / Cash / Change, Today's sales row", async ({
    page,
    context,
  }) => {
    await setTenantCookie(context, BASE);
    const sku = await discoverSku(page);
    const totalCents = await ringOne(page, sku);
    expect(totalCents, "the test product must cost more than $0.02").toBeGreaterThan(2);
    const cardCents = Math.floor(totalCents / 2);
    const cashAppliedCents = totalCents - cardCents;
    const cashHandedCents = cashAppliedCents + 1000; // $10.00 of change

    await page.getByTestId("split-payment-link").click();
    await page.getByLabel("Payment 1 amount").fill(plain(cardCents));
    await page.getByLabel("Payment 2 amount").fill(plain(cashHandedCents));
    await expect(page.getByTestId("change-due")).toHaveText("Change $10.00");

    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/orders\/counter-sale(\?|$)/.test(r.url()),
    );
    await page.getByRole("button", { name: "Complete & show receipt" }).click();
    expect((await post).status(), "201").toBe(201);
    await expect(page.getByTestId("counter-sale-receipt")).toBeVisible({ timeout: 20_000 });

    // one row per leg, non-cash first, then cash (what was handed over), then Change
    const rows = page.getByTestId("receipt-tender-line");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`Card${dollars(cardCents)}`);
    await expect(rows.nth(1)).toContainText(`Cash${dollars(cashHandedCents)}`);
    await expect(page.getByTestId("receipt-change")).toContainText("$10.00");
    await expect(page.getByTestId("receipt-tendered")).toHaveCount(0); // the Cash line IS the cash handed over
    await expect(page.getByTestId("receipt-method")).toContainText("Card + Cash");

    // Today's sales: the amount applied per method (cash net of change)
    await page.goto(COUNTER);
    await page.getByRole("button", { name: "Today's sales" }).click();
    await expect(
      page.getByText(`Card ${dollars(cardCents)} + Cash ${dollars(cashAppliedCents)}`).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
