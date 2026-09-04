import { test, expect } from "@playwright/test";
import { fillWorkspaceIfShown, setTenantCookie } from "./helpers/auth";
import { apiBase, operatorAccessToken } from "./helpers/api";
import { CREDENTIALS, TENANT_SLUG } from "./helpers/constants";

type SessionRow = { id: string; createdAt: string };

async function refreshTokenFromPage(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => localStorage.getItem("rf:op:refreshToken") || localStorage.getItem("refreshToken") || "",
  );
}

/**
 * Log in as the dedicated e2e_sessions_op OPERATOR (L-050) — never the shared
 * admin/operator.json identity every storageState: operator.json project also loads.
 * A local copy of helpers/auth.ts's loginAsOperator with a different username/password
 * rather than parameterizing the shared helper, to keep this spec's dedicated-identity
 * requirement self-contained.
 */
async function loginAsSessionsOp(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  await page.getByLabel("Username or email").fill(CREDENTIALS.sessionsOp.username);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.sessionsOp.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

test.describe("Active Sessions identity (F14 / B155)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await setTenantCookie(context, baseURL ?? "", TENANT_SLUG);
  });

  test("REG-B155 a session captured before a rotation is still listed with its sign-in time, can be revoked, and the revoke bites", async ({
    page,
    baseURL,
  }) => {
    await loginAsSessionsOp(page);
    const api = `${apiBase(baseURL ?? page.url())}/api/v1`;
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Tenant-Slug": TENANT_SLUG,
    });

    const token0 = await operatorAccessToken(page);
    const rows = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: headers(token0) })
    ).json()) as SessionRow[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const sid = rows[0]!.id; // newest createdAt = this login (CI runs workers: 1)
    const signedInAt = rows[0]!.createdAt;

    // Rotate: the row must keep its id and createdAt.
    const rt0 = await refreshTokenFromPage(page);
    expect(rt0).not.toBe("");
    const refresh1 = await page.request.post(`${api}/auth/refresh`, {
      headers: { "X-Tenant-Slug": TENANT_SLUG },
      data: { refreshToken: rt0 },
    });
    expect(refresh1.status()).toBe(200);
    const pair1 = (await refresh1.json()) as { accessToken: string; refreshToken: string };
    const rows2 = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: headers(pair1.accessToken) })
    ).json()) as SessionRow[];
    const survivor = rows2.find((r) => r.id === sid);
    expect(survivor).toBeDefined();
    expect(survivor!.createdAt).toBe(signedInAt);

    // The UI still shows that row and can revoke it. SessionsCard lives inside
    // MyAccountTab, so it only renders at `?tab=account` — bare /settings is the
    // hub of section cards and has no [data-session-id] rows at all.
    await page.goto("/settings?tab=account");
    const row = page.locator(`[data-session-id="${sid}"]`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    const revokeResp = page.waitForResponse(
      (r) => r.url().includes(`/auth/sessions/${sid}`) && r.request().method() === "DELETE",
    );
    await row.getByRole("button", { name: "Revoke" }).click();
    expect((await revokeResp).status()).toBe(200);
    await expect(page.getByText("Session revoked")).toBeVisible();
    await expect(row).toHaveCount(0);

    // The revoke hit THIS session: the rotated refresh token is dead.
    const refresh2 = await page.request.post(`${api}/auth/refresh`, {
      headers: { "X-Tenant-Slug": TENANT_SLUG },
      data: { refreshToken: pair1.refreshToken },
    });
    expect(refresh2.status()).toBe(401);
  });

  test("REG-B155 a failed revoke re-syncs the list instead of leaving a phantom row", async ({
    page,
    baseURL,
  }) => {
    await loginAsSessionsOp(page);
    let routeHits = 0;
    let listCalls = 0;
    await page.route("**/auth/sessions/*", (route) => {
      if (route.request().method() === "DELETE") {
        routeHits += 1;
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: '{"message":"Session not found"}',
        });
      }
      return route.continue();
    });
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/auth\/sessions(\?|$)/.test(r.url())) listCalls += 1;
    });

    await page.goto("/settings?tab=account");
    const firstRow = page.locator("[data-session-id]").first();
    await firstRow.scrollIntoViewIfNeeded();
    await expect(firstRow).toBeVisible();
    const listCallsBefore = listCalls;

    await firstRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Failed to revoke session")).toBeVisible();
    expect(routeHits).toBe(1);
    await expect.poll(() => listCalls).toBe(listCallsBefore + 1);

    // Cleanup: nothing to revoke — the DELETE was intercepted; the session dies with the context.
    void baseURL;
  });

  test("REG-B155 a sign-out-all whose revokes fail says so instead of claiming every session is gone", async ({
    page,
    baseURL,
  }) => {
    await loginAsSessionsOp(page);
    const api = `${apiBase(baseURL ?? page.url())}/api/v1`;
    const tenantHeaders = { "X-Tenant-Slug": TENANT_SLUG };

    // Snapshot every session that already exists for e2e_sessions_op before this test adds its
    // own — including any orphaned row the intercepted-DELETE test above left behind on the
    // server (its mocked 403 never reaches the real API, so that login's session outlives the
    // test). e2e_sessions_op is dedicated to this spec (L-050) — never shared with "setup" or
    // any storageState: operator.json project — so nothing outside this file's own runs is at
    // risk; the cleanup at the end still deletes ONLY what this test created.
    const preexisting = new Set(
      (
        (await (
          await page.request.get(`${api}/auth/sessions`, {
            headers: {
              Authorization: `Bearer ${await operatorAccessToken(page)}`,
              ...tenantHeaders,
            },
          })
        ).json()) as SessionRow[]
      ).map((s) => s.id),
    );

    // A second live session — the card only renders "Sign out all" when sessions.length > 1.
    const extraLogin = await page.request.post(`${api}/auth/login`, {
      headers: tenantHeaders,
      data: {
        username: CREDENTIALS.sessionsOp.username,
        password: CREDENTIALS.sessionsOp.password,
      },
    });
    expect(extraLogin.status()).toBe(200);

    let deleteHits = 0;
    let listCalls = 0;
    await page.route("**/auth/sessions/*", (route) => {
      if (route.request().method() === "DELETE") {
        deleteHits += 1;
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: '{"message":"Session not found"}',
        });
      }
      return route.continue();
    });
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/auth\/sessions(\?|$)/.test(r.url())) listCalls += 1;
    });

    await page.goto("/settings?tab=account");
    const rows = page.locator("[data-session-id]");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    await rows.first().scrollIntoViewIfNeeded();
    const rowCount = await rows.count();
    const listCallsBefore = listCalls;

    await page.getByRole("button", { name: "Sign out all" }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).click();

    // The old branch swallowed every rejection (`.catch(() => null)`), emptied the list and
    // toasted "All sessions revoked" while every session stayed live. Now it names the failure,
    // keeps the rows and re-syncs from the server.
    await expect(page.getByText("Some sessions could not be revoked")).toBeVisible();
    await expect(page.getByText("All sessions revoked")).toHaveCount(0);
    expect(deleteHits).toBe(rowCount);
    await expect.poll(() => listCalls).toBe(listCallsBefore + 1);
    await expect(rows).toHaveCount(rowCount);

    // Cleanup: the intercept let no revoke through, so drop the rows over the real API.
    await page.unroute("**/auth/sessions/*");
    const token = await operatorAccessToken(page);
    const headers = { Authorization: `Bearer ${token}`, ...tenantHeaders };
    const live = (await (
      await page.request.get(`${api}/auth/sessions`, { headers })
    ).json()) as SessionRow[];
    for (const s of live) {
      // Never a row that predates this test — see `preexisting` above.
      if (preexisting.has(s.id)) continue;
      await page.request.delete(`${api}/auth/sessions/${s.id}`, { headers });
    }
  });
});
