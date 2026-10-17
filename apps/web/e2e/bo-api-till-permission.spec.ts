/**
 * BO-07 (D3): the till permission per operator. An OPERATOR whose admin switched the ORDERS group off
 *   - sees no Counter entry in the nav (rail at lg+, drawer below),
 *   - reaches /orders/counter-sale and gets the plain no-access panel (no sale UI, no error toast),
 *   - is refused by the API on the till (403 PERMISSION_DENIED, groups ["ORDERS"]).
 * At 390 / 768 / 1440 px, no horizontal overflow.
 *
 * LOCAL LANE ONLY, same guards as 71-73: the tenant is put on the in_store_shipping_retailer profile (counter on) and restored
 * row-for-row in afterAll; the seeded operator's `deniedPermissionGroups` is set by SQL on the approved test tenant (no API writes
 * it yet) on a provably local database, and put back exactly (value and version) in afterAll. Sells nothing. Needs `npm run local:sa`.
 * Cannot run on a machine without the compose stack.
 */
import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { CREDENTIALS, TENANT_SLUG } from "./helpers/constants";
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
import { assertLocalFulfilmentTarget } from "../lib/local-fulfilment-guard";

const req = createRequire(__filename);
const { Client } = req("pg");
const { localConnectionConfig } = req("../../api/scripts/lib/local-db-target.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const COUNTER = "/orders/counter-sale";
const NO_ACCESS = "Your admin hasn't turned on selling for your account.";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
let savedUser: { id: string; denied: string[]; version: number } | null = null;
const target = () => localTarget(apiBase(BASE));

/** One short-lived connection per call, built from the CHECKED explicit fields of a provably local database URL. */
async function withDb<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const t = target();
  assertLocalFulfilmentTarget(t);
  const client = new Client(localConnectionConfig(t.dbUrl));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setDenied(groups: string[], version?: number): Promise<void> {
  // LOCAL-ONLY direct-DB write: withDb() runs assertLocalFulfilmentTarget first (local web + API + DB, not CI, approved test
  // tenant); it touches the one seeded operator row of that tenant and afterAll writes the saved values back.
  await withDb(async (c) => {
    const r = await c.query(
      `UPDATE "User" u SET "deniedPermissionGroups" = $3::"OperatorPermissionGroup"[],
         "permissionsVersion" = COALESCE($4, u."permissionsVersion" + 1)
       FROM "Tenant" t WHERE u."tenantId" = t.id AND t.slug = $1 AND u.username = $2`,
      [TENANT_SLUG, CREDENTIALS.operator.username, groups, version ?? null],
    );
    if (r.rowCount !== 1)
      throw new Error(`expected to update exactly one operator, got ${r.rowCount}`);
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  before = await snapshotFulfilmentConfig(target());
  capabilityBefore = await readApiCapability(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
  savedUser = await withDb(async (c) => {
    const r = await c.query(
      `SELECT u.id, u."deniedPermissionGroups"::text[] AS denied, u."permissionsVersion" AS version
         FROM "User" u JOIN "Tenant" t ON t.id = u."tenantId" WHERE t.slug = $1 AND u.username = $2`,
      [TENANT_SLUG, CREDENTIALS.operator.username],
    );
    if (r.rows.length !== 1) throw new Error("the seeded operator was not found");
    return r.rows[0];
  });
  await setDenied(["ORDERS"]);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  try {
    if (savedUser) await setDenied(savedUser.denied, savedUser.version);
  } finally {
    // Runs even when putting the operator back fails: the tenant profile is never left changed.
    if (before) {
      const restored = await restoreFulfilmentConfig(target(), before);
      expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
      await waitForApiCapability(target(), capabilityBefore, 60_000);
    }
  }
});

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const vp of VIEWPORTS) {
  test.describe(`BO-07 till permission @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the nav has no Counter entry for an operator without ORDERS", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      await expect(page.getByRole("heading", { name: /orders/i }).first()).toBeVisible();
      if (vp.width < 1024) {
        await page.getByRole("button", { name: "Open navigation menu" }).first().click();
        await expect(page.getByTestId("sidebar-drawer-aside")).toBeVisible();
        await expect(
          page.getByTestId("sidebar-drawer-aside").getByRole("link", { name: "Counter" }),
        ).toHaveCount(0);
      } else {
        await expect(page.getByTestId("sidebar-aside")).toBeVisible();
        await expect(
          page.getByTestId("sidebar-aside").getByRole("link", { name: "Counter" }),
        ).toHaveCount(0);
      }
      expect(await overflow(page), "no horizontal overflow").toBeLessThanOrEqual(0);
    });

    test("the Counter URL shows the plain no-access panel, no sale UI, no toast", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto(COUNTER);
      await expect(page.getByText(NO_ACCESS)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel("Scan or search items")).toHaveCount(0);
      await expect(
        page.getByRole("status").filter({ hasText: /denied|permission|access/i }),
      ).toHaveCount(0);
      expect(await overflow(page), "no horizontal overflow").toBeLessThanOrEqual(0);
    });
  });
}

test("the API refuses the till for an operator without ORDERS (403 PERMISSION_DENIED)", async ({
  page,
  context,
}) => {
  await setTenantCookie(context, BASE);
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  expect(token, "the operator is signed in").toBeTruthy();
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/orders/counter-sale/today`, {
    headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe("PERMISSION_DENIED");
  expect(body.groups).toEqual(["ORDERS"]);
});
