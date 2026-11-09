/**
 * WP11 (SA-1106 C2): review then save. Staging writes nothing; the sheet saves the whole set in ONE request;
 * a stale save keeps the stage; Undo reverses the saved set. Proved at 1440, 768 and 390.
 *
 * Every API call is mocked (the same pattern as bo-web-console-radios.spec.ts), the tenant is a throwaway `qa-*`
 * slug, and no live tenant is ever contacted. Auth is a locally faked super-admin token the page only decodes
 * client-side. `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { mockOverviewReads, mockUnmockedBackoffice } from "./helpers/bo-api-mocks";

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

const TENANT_ID = "qa-bo-changes-1";
const PLAN_KEY = "SCALE";

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeSuperAdminToken(): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "qa-fake-admin",
    role: "SUPER_ADMIN",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.fake-signature`;
}

const row = (key: string, label: string, area: string) => ({
  key,
  kind: "boolean",
  area,
  label,
  description: `${label} for this business.`,
  lifecycle: "ga",
  internal: false,
  gate: { via: "service", state: "enforced" },
  via: "service",
  billing: { skus: [] },
  grant: { override: true, plan: false, mode: false },
});
const effective = (key: string, area: string) => ({
  key,
  area,
  serving: false,
  resolver: false,
  source: "NONE",
  detail: { planKey: PLAN_KEY, catalogVersionId: "catalog-v11", enforced: true },
  billing: { charged: false },
});

const ROWS = [
  row("msrp", "MSRP on invoices", "office"),
  row("sales_agents", "Sales agents", "office"),
  row("ocr", "Scan invoices", "office"),
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
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

const SAVED_SET = {
  id: "cs-hist-1",
  action: "FEATURE_CHANGE_SET_APPLIED",
  createdAt: "2026-11-09T10:00:00.000Z",
  actor: { email: "maria@acme.test", username: "maria" },
  meta: {
    reason: "Pilot ended",
    changes: [
      {
        type: "override",
        key: "msrp",
        before: { id: "o1", effect: "GRANT", kind: "COMP", expiresAt: null },
        after: { effect: "DENY", kind: "COMP", expiresAt: null },
        createdIds: ["o2"],
        revokedIds: ["o1"],
      },
    ],
  },
};

const ON = { effect: "GRANT", kind: "COMP", expiresAt: null };
const OFF = { effect: "DENY", kind: "COMP", expiresAt: null };

interface Recorded {
  /** POSTs to .../features/changes with dryRun true / without it. */
  dryRuns: unknown[];
  saves: unknown[];
  undos: string[];
}

async function gotoConsole(
  page: Page,
  opts: { saveStatus?: number; history?: boolean } = {},
): Promise<Recorded> {
  const rec: Recorded = { dryRuns: [], saves: [], undos: [] };
  await mockUnmockedBackoffice(page);
  await mockOverviewReads(page, TENANT_ID, { fulfilment_model: "unset", counter_sales: "unset" });
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, {
      id: TENANT_ID,
      slug: "qa-bo-changes",
      name: "QA Changes Tenant",
      status: "ACTIVE",
      plan: "BUSINESS",
      planKey: PLAN_KEY,
      trialEndsAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      businessName: "QA Changes Tenant",
      primaryColor: null,
      logoKey: null,
      addressLine1: null,
      city: null,
      state: null,
      zip: null,
      country: null,
      phone: null,
      subscription: null,
      counts: null,
    }),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/admin(\\?.*)?$`), (route) =>
    fulfillJson(route, { admin: null }),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/addons(\\?.*)?$`), (route) =>
    fulfillJson(route, []),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`), (route) =>
    fulfillJson(route, []),
  );
  await page.route(/\/platform-admin\/audit-logs(\?.*)?$/, (route) => {
    const applied = route.request().url().includes("action=FEATURE_CHANGE_SET_APPLIED");
    return fulfillJson(route, {
      data: opts.history && applied ? [SAVED_SET] : [],
      meta: { total: 0, pages: 1 },
    });
  });
  await page.route(/\/platform-admin\/features\/registry(\?.*)?$/, (route) =>
    fulfillJson(route, ROWS),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/effective(\\?.*)?$`),
    (route) =>
      fulfillJson(route, {
        inputsHash: "hash-1",
        effective: ROWS.map((r) => effective(r.key, r.area)),
      }),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  await page.route(/\/platform-admin\/business-profiles(\?.*)?$/, (route) =>
    fulfillJson(route, { profiles: [] }),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/changes(/[^/]+/undo)?$`),
    (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return fulfillJson(route, {});
      if (req.url().endsWith("/undo")) {
        rec.undos.push(req.url());
        return fulfillJson(route, { changeSetId: "u1", undoOf: "cs-1" });
      }
      const body = req.postDataJSON() as {
        dryRun?: boolean;
        changes: { key: string; action: string }[];
      };
      if (body.dryRun) {
        rec.dryRuns.push(body);
        return fulfillJson(route, {
          inputsHash: "hash-1",
          stale: false,
          changes: body.changes.map((c) => ({
            key: c.key,
            before: null,
            after: c.action === "GRANT" ? ON : OFF,
            unchanged: false,
          })),
        });
      }
      rec.saves.push(body);
      if (opts.saveStatus === 409) {
        return fulfillJson(route, { code: "FEATURE_INPUTS_CHANGED", message: "Changed." }, 409);
      }
      return fulfillJson(route, { changeSetId: "cs-1", hashAfter: "hash-2", changes: [] });
    },
  );
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  if (opts.history) {
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText(/maria@acme.test turned off MSRP on invoices/)).toBeVisible({
      timeout: 15_000,
    });
    return rec;
  }
  await page.getByRole("button", { name: "Features", exact: true }).click();
  await expect(page.locator('[data-feature-key="msrp"]')).toBeVisible({ timeout: 15_000 });
  return rec;
}

async function stageThree(page: Page) {
  await page.getByRole("button", { name: "Turn off MSRP on invoices for this business" }).click();
  await page.getByRole("button", { name: "Turn off Sales agents for this business" }).click();
  await page.getByRole("button", { name: "Turn on Scan invoices for this business" }).click();
  await expect(page.getByTestId("stage-count")).toContainText("3 changes");
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`Review then save, ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("staging three changes writes nothing and shows the bar", async ({ page }) => {
      const rec = await gotoConsole(page);
      await stageThree(page);
      expect(rec.saves).toEqual([]);
      expect(rec.dryRuns).toEqual([]);
      await page.getByRole("button", { name: "Discard" }).click();
      await expect(page.getByTestId("stage-count")).toHaveCount(0);
    });

    test("Review lists the changes, Save sends ONE request with the whole set, then Undo is offered", async ({
      page,
    }) => {
      const rec = await gotoConsole(page);
      await stageThree(page);
      await page.getByRole("button", { name: "Review changes" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("MSRP on invoices: Off from plan to Off")).toBeVisible();
      await expect(dialog.getByText("Scan invoices: Off from plan to On")).toBeVisible();
      await noSideScroll(page);
      await dialog.getByLabel(/Why are you making these changes/).fill("Pilot ended");
      await dialog.getByRole("button", { name: "Save 3 changes" }).click();
      await expect(page.getByText("Saved 3 changes.")).toBeVisible();
      expect(rec.saves).toHaveLength(1);
      expect(rec.saves[0]).toMatchObject({
        expected: "hash-1",
        reason: "Pilot ended",
        changes: [
          { key: "msrp", action: "DENY" },
          { key: "sales_agents", action: "DENY" },
          { key: "ocr", action: "GRANT" },
        ],
      });
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => rec.undos.length).toBe(1);
      expect(rec.undos[0]).toContain("/features/changes/cs-1/undo");
    });

    test("History reads the saved set as a sentence; Restore opens the sheet and Undo this change works", async ({
      page,
    }) => {
      const rec = await gotoConsole(page, { history: true });
      await expect(page.getByText(/Reason: Pilot ended\./)).toBeVisible();
      await noSideScroll(page);
      await page.getByRole("button", { name: "Restore the earlier settings" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(/MSRP on invoices: .* to On/)).toBeVisible();
      await noSideScroll(page);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Undo this change" }).click();
      await expect.poll(() => rec.undos.length).toBe(1);
      expect(rec.undos[0]).toContain("/features/changes/cs-hist-1/undo");
    });

    test("a stale save says Changed by someone else and keeps the staged changes", async ({
      page,
    }) => {
      const rec = await gotoConsole(page, { saveStatus: 409 });
      await stageThree(page);
      await page.getByRole("button", { name: "Review changes" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/Why are you making these changes/).fill("Pilot ended");
      await dialog.getByRole("button", { name: "Save 3 changes" }).click();
      await expect(dialog.getByText(/Changed by someone else/)).toBeVisible();
      expect(rec.saves).toHaveLength(1);
      await noSideScroll(page);
    });
  });
}
