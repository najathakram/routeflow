/**
 * Units v2 (units-v2-save-undo): the product page price save / undo flow, against SPRINT-CONTRACT (LEAD FINAL RULING 18:45Z).
 *   POST /products/:id/prices {expectedRevision, expectedPriceState, patches, ...} -> {revision, auditId, undo, grid}
 *   POST /products/:id/prices/undo {auditId, expectedRevision, expectedPriceState}
 *   409 LADDER_REVISION_STALE | 400 PRICE_EDIT_INVALID | 409 PRICE_UNDO_UNAVAILABLE | 409 PRICING_RULES_NOT_READY
 *
 * LOCAL LANE ONLY (project `units-v2`). Authored before the server half (K1) merged; run it the moment K1 is on the stack.
 * Writes on the approved test tenant only (assertTestTenant first): one throwaway boxed product per test (Box of 12, Retail 24.00),
 * retired softly (inactive) in a finally. The request bodies are asserted by SHAPE (tokens present), never by token value.
 * A tenant not served `flag.units_prices_v2` FAILS the spec (never skips).
 */
import { test, expect, type Page, type Request } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { UNITS_V2_IDS as ID } from "./helpers/units-v2-ids";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const START = 24;
const NEXT = 31.5;
const OTHER = 28;
const TIER = 1; // Retail: the anchor row's Retail cell is always editable

type Ctx = { api: string; headers: Record<string, string> };
type Grid = {
  revision: number;
  priceState: string;
  anchor: string;
  rows: { ref: string; kind: string; cells: { tier: number; value: number; source: string }[] }[];
};

async function createProduct(page: Page, ctx: Ctx, tag: string) {
  const res = await page.request.post(`${ctx.api}/products`, {
    headers: ctx.headers,
    data: {
      name: `QA UV2 Save ${tag}`,
      sku: `QAUV2S${tag}`,
      unit: "Box",
      unitsPerBox: 12,
      pricePerUnit: START.toFixed(2),
    },
  });
  expect(res.ok(), `create the throwaway product: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as any).id as string;
}

async function readGrid(page: Page, ctx: Ctx, id: string): Promise<Grid> {
  const res = await page.request.get(`${ctx.api}/products/${id}/price-grid`, {
    headers: ctx.headers,
  });
  expect(res.ok(), `GET price-grid returned ${res.status()}`).toBe(true);
  const g = (await res.json()) as Grid;
  expect(typeof g.revision, "grid carries revision (K1)").toBe("number");
  expect(typeof g.priceState, "grid carries priceState (K1)").toBe("string");
  return g;
}

const retailOf = (g: Grid, ref: string) =>
  g.rows.find((r) => r.ref === ref)!.cells.find((c) => c.tier === TIER)!.value;

/** A second writer: saves one Retail price through the API with the CURRENT revision and priceState. */
async function apiSave(page: Page, ctx: Ctx, id: string, ref: string, to: number) {
  const g = await readGrid(page, ctx, id);
  const res = await page.request.post(`${ctx.api}/products/${id}/prices`, {
    headers: ctx.headers,
    data: {
      expectedRevision: g.revision,
      expectedPriceState: g.priceState,
      patches: [{ ref, tier: TIER, to }],
    },
  });
  expect(res.ok(), `second writer save returned ${res.status()}`).toBe(true);
}

const isWrite = (id: string, suffix: "prices" | "prices/undo") => (r: Request) =>
  r.method() === "POST" && new URL(r.url()).pathname.endsWith(`/products/${id}/${suffix}`);

const cell = (page: Page, ref: string) =>
  page.locator(`[data-testid="${ID.cell(ref, TIER)}"]:visible`);
const input = (page: Page, ref: string) =>
  page.locator(`[data-testid="${ID.input(ref, TIER)}"]:visible`);
const status = (page: Page) => page.locator(`[data-testid="${ID.saveStatus}"]:visible`).first();

/** Open the product, click the anchor Retail cell (edit mode starts, its input takes focus), type a Set price. */
async function startEdit(page: Page, id: string, ref: string, typed: string) {
  await page.goto(`/products/${id}`);
  await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
  await cell(page, ref).getByRole("button").click();
  await expect(input(page, ref)).toBeFocused();
  await input(page, ref).fill(typed);
}

async function setUp(page: Page, context: any, vpName: string) {
  assertTestTenant(TENANT_SLUG, "units-v2 save/undo fixtures");
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const tag = `${Date.now().toString(36).toUpperCase()}${vpName}`;
  const id = await createProduct(page, ctx, tag);
  const g = await readGrid(page, ctx, id);
  return { ctx, id, ref: g.anchor };
}

async function retire(page: Page, ctx: Ctx, id: string) {
  if (!id) return;
  const r = await page.request.patch(`${ctx.api}/products/${id}`, {
    headers: ctx.headers,
    data: { isActive: false },
  });
  expect(r.ok(), `retire the throwaway product: ${r.status()}`).toBeTruthy();
}

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 save / undo @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("save (Ctrl/Cmd+S, then the Save button) sends tokens, persists, and offers Undo", async ({
      page,
      context,
    }, info) => {
      const { ctx, id, ref } = await setUp(page, context, vp.name);
      try {
        // Keyboard save.
        await startEdit(page, id, ref, String(NEXT));
        const kbReq = page.waitForRequest(isWrite(id, "prices"));
        await page.keyboard.press("ControlOrMeta+s");
        const body = (await kbReq).postDataJSON();
        expect(typeof body.expectedRevision, "expectedRevision present").toBe("number");
        expect(typeof body.expectedPriceState, "expectedPriceState present").toBe("string");
        expect(body.expectedPriceState.length).toBeGreaterThan(0);
        expect(Array.isArray(body.patches) && body.patches.length > 0, "patches present").toBe(
          true,
        );
        expect(body.patches[0]).toMatchObject({ ref, tier: TIER, to: NEXT });
        await expect(status(page)).toContainText(/Saved/, { timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
        await shot(page, info, "save-undo-saved");

        await page.reload();
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        await expect(cell(page, ref)).toContainText("31.50");
        expect(retailOf(await readGrid(page, ctx, id), ref)).toBe(NEXT);

        // Button save (a second price).
        await cell(page, ref).getByRole("button").click();
        await input(page, ref).fill(String(OTHER));
        const btnReq = page.waitForRequest(isWrite(id, "prices"));
        await page.locator(`[data-testid="${ID.ebSave}"]:visible`).click();
        const body2 = (await btnReq).postDataJSON();
        expect(typeof body2.expectedRevision).toBe("number");
        expect(typeof body2.expectedPriceState).toBe("string");
        await expect(status(page)).toContainText(/Saved/, { timeout: 15_000 });
        await page.reload();
        await expect(cell(page, ref)).toContainText("28.00");
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("Undo posts to /prices/undo, restores the old price, and clears the Undo", async ({
      page,
      context,
    }, info) => {
      const { ctx, id, ref } = await setUp(page, context, vp.name);
      try {
        await startEdit(page, id, ref, String(NEXT));
        await page.keyboard.press("ControlOrMeta+s");
        await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible({
          timeout: 15_000,
        });

        const undoReq = page.waitForRequest(isWrite(id, "prices/undo"));
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        const body = (await undoReq).postDataJSON();
        expect(typeof body.auditId, "auditId present").toBe("string");
        expect(typeof body.expectedRevision).toBe("number");
        expect(typeof body.expectedPriceState).toBe("string");

        await expect(status(page)).toContainText("Save undone.", { timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
        await shot(page, info, "save-undo-undone");

        await page.reload();
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        await expect(cell(page, ref)).toContainText("24.00");
        expect(retailOf(await readGrid(page, ctx, id), ref)).toBe(START);
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("stale save: 409 shows the changed-since notice, Reload prices brings the fresh value", async ({
      page,
      context,
    }, info) => {
      const { ctx, id, ref } = await setUp(page, context, vp.name);
      try {
        await startEdit(page, id, ref, String(NEXT));
        // A second writer moves the same product while the edit is open.
        await apiSave(page, ctx, id, ref, OTHER);

        const staleRes = page.waitForResponse(
          (r) => isWrite(id, "prices")(r.request()) && r.status() === 409,
        );
        await page.keyboard.press("ControlOrMeta+s");
        await staleRes;

        const notice = page
          .getByRole("alert")
          .filter({ hasText: /Prices changed since you opened this; review and save again/ });
        await expect(notice).toBeVisible({ timeout: 15_000 });
        await shot(page, info, "save-undo-stale");
        await notice.getByRole("button", { name: "Reload prices" }).click();

        await page.reload();
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        await expect(cell(page, ref)).toContainText("28.00");
        expect(retailOf(await readGrid(page, ctx, id), ref)).toBe(OTHER);
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("Change prices: Raise 5% then Apply moves the draft with no request; Save sends one POST", async ({
      page,
      context,
    }, info) => {
      const { ctx, id, ref } = await setUp(page, context, vp.name);
      try {
        let writes = 0;
        page.on("request", (r) => {
          if (isWrite(id, "prices")(r)) writes++;
        });
        await page.goto(`/products/${id}`);
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        await page.locator(`[data-testid="${ID.btnEdit}"]:visible`).click();
        await page.locator(`[data-testid="${ID.btnChange}"]:visible`).first().click();
        const panel = page.getByTestId(ID.changePanel);
        await expect(panel).toBeVisible();

        await panel.getByText("Raise", { exact: true }).click();
        await panel.getByLabel("Amount").fill("5");
        await expect(page.getByTestId(ID.changePreview)).toContainText(/will change/);
        await panel.getByRole("button", { name: "Apply" }).click();

        await expect(panel).toHaveCount(0);
        await expect(page.getByTestId(ID.editbar)).toContainText(/\d+ unsaved/);
        expect(writes, "Apply folds into the draft; it sends nothing").toBe(0);
        await shot(page, info, "save-undo-change-prices-draft");

        const req = page.waitForRequest(isWrite(id, "prices"));
        await page.locator(`[data-testid="${ID.ebSave}"]:visible`).click();
        const body = (await req).postDataJSON();
        expect(typeof body.expectedRevision).toBe("number");
        expect(typeof body.expectedPriceState).toBe("string");
        expect(body.patches.length).toBeGreaterThan(0);
        await expect(status(page)).toContainText(/Saved/, { timeout: 15_000 });
        expect(writes, "exactly one write for the whole Change prices flow").toBe(1);
        expect(retailOf(await readGrid(page, ctx, id), ref)).not.toBe(START);
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("Escape closes Change prices and focus returns to its opener", async ({
      page,
      context,
    }) => {
      const { ctx, id } = await setUp(page, context, vp.name);
      try {
        await page.goto(`/products/${id}`);
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        const opener = page.locator(`[data-testid="${ID.btnChange}"]:visible`).first();
        await opener.click();
        await expect(page.getByTestId(ID.changePanel)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId(ID.changePanel)).toHaveCount(0);
        await expect(opener).toBeFocused();
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("order unit switch is disabled in edit mode and a Save never sends orderUnit", async ({
      page,
      context,
    }, info) => {
      const { ctx, id, ref } = await setUp(page, context, vp.name);
      try {
        await page.goto(`/products/${id}`);
        await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
        await page.locator(`[data-testid="${ID.btnEdit}"]:visible`).click();
        const select = page.getByTestId(ID.orderUnit);
        await expect(select).toBeVisible();
        await expect(select).toHaveAttribute("aria-disabled", "true");
        await expect(page.getByText("Available after units settings update").first()).toBeVisible();

        // Picking is impossible: the control is not operable, so a forced pick fails or changes nothing.
        const before = await select.inputValue();
        await select.selectOption({ index: 1 }, { timeout: 2_000 }).catch(() => undefined);
        await expect(select).toHaveValue(before);
        await shot(page, info, "save-undo-order-unit-disabled");

        // Other edits still save, and the body carries no orderUnit.
        await input(page, ref).fill(String(NEXT));
        const req = page.waitForRequest(isWrite(id, "prices"));
        await page.locator(`[data-testid="${ID.ebSave}"]:visible`).click();
        const body = (await req).postDataJSON();
        expect("orderUnit" in body, "no orderUnit key in the POST body").toBe(false);
        expect(body.patches.length).toBeGreaterThan(0);
        await expect(status(page)).toContainText(/Saved/, { timeout: 15_000 });
      } finally {
        await retire(page, ctx, id);
      }
    });
  });
}
