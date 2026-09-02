import { test, expect } from "@playwright/test";
import { loginAsSuperAdmin, logout } from "./helpers/auth";
import { apiBase } from "./helpers/api";
import { CREDENTIALS, HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "./helpers/constants";

/** Reads the `sub` claim out of a JWT without verifying it (test-side identity check only). */
function jwtSub(token: string): string {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return "";
  try {
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof claims?.sub === "string" ? claims.sub : "";
  } catch {
    return "";
  }
}

test.describe("Impersonation sign-out (F14 / B138)", () => {
  test("REG-B138 exiting an impersonation from the avatar menu revokes none of the tenant admin's sessions and never posts /auth/logout", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");
    const api = `${apiBase(baseURL ?? page.url())}/api/v1`;
    const tenantHeaders = { "X-Tenant-Slug": TENANT_SLUG };

    // 1. A real TENANT_ADMIN session to protect (independent of anything the UI does).
    const adminLogin = await page.request.post(`${api}/auth/login`, {
      headers: tenantHeaders,
      data: {
        username: CREDENTIALS.tenantAdmin.username,
        password: CREDENTIALS.tenantAdmin.password,
      },
    });
    test.skip(
      adminLogin.status() !== 200,
      `e2e tenant has no TENANT_ADMIN (login ${adminLogin.status()}) — run apps/api/scripts/e2e-seed.js`,
    );
    const adminBody = (await adminLogin.json()) as { accessToken: string; user?: { id?: string } };
    const adminAccess = adminBody.accessToken;
    const adminUserId = adminBody.user?.id ?? "";
    expect(adminUserId).not.toBe("");
    const adminHeaders = { Authorization: `Bearer ${adminAccess}`, ...tenantHeaders };
    const sessionsBefore = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: adminHeaders })
    ).json()) as { id: string }[];
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(1);
    const protectedSessionId = sessionsBefore[0]!.id;

    let logoutCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/auth/logout")) logoutCalls += 1;
    });

    try {
      // 2. Super-admin → find the e2e tenant BY SLUG (client-data policy: never `limit=1`).
      await loginAsSuperAdmin(page);
      const saToken = await page.evaluate(() => localStorage.getItem("superAdminToken") ?? "");
      const list = await (
        await page.request.get(`${api}/platform-admin/tenants?search=${TENANT_SLUG}&limit=50`, {
          headers: { Authorization: `Bearer ${saToken}` },
        })
      ).json();
      const matches = (list?.data ?? []).filter((t: { slug: string }) => t.slug === TENANT_SLUG);
      test.skip(matches.length !== 1, `e2e tenant not found by slug (${matches.length} matches)`);
      const tenant = matches[0] as { id: string; slug: string };

      // 3. Enter impersonation through the real UI (fallback: API + localStorage).
      await page.goto("/admin/tenants");
      await page.getByPlaceholder("Search by slug or name...").fill(TENANT_SLUG);
      const row = page.getByRole("row", { name: new RegExp(TENANT_SLUG) }).first();
      const impersonateBtn = row.getByRole("button", { name: "Impersonate" });
      if (await impersonateBtn.count()) {
        await impersonateBtn.click();
      } else {
        const imp = await (
          await page.request.post(`${api}/platform-admin/tenants/${tenant.id}/impersonate`, {
            headers: { Authorization: `Bearer ${saToken}` },
          })
        ).json();
        await page.evaluate(
          ([token, slug, username]) => {
            localStorage.setItem("impersonationToken", token);
            localStorage.setItem("impersonationTenantSlug", slug);
            if (username) localStorage.setItem("impersonationUsername", username);
          },
          [
            imp.accessToken as string,
            tenant.slug,
            (imp.impersonatedUser?.username ?? "") as string,
          ],
        );
        await context.setExtraHTTPHeaders({ "x-tenant-slug": TENANT_SLUG });
        await page.goto("/dashboard");
      }
      await page.waitForURL("**/dashboard", { timeout: 30_000 });
      await expect(page.getByText(/Impersonating/)).toBeVisible();
      const impToken = await page.evaluate(() => localStorage.getItem("impersonationToken") ?? "");
      expect(impToken).not.toBe("");
      // platform-admin's impersonate() picks the tenant's TENANT_ADMIN with an
      // UNORDERED findFirst, so the impersonated subject is only guaranteed to be
      // the admin logged in above while the tenant holds exactly one ACTIVE
      // TENANT_ADMIN. Everything below counts and identifies THAT user's sessions —
      // on any other subject this is a mis-seeded tenant, not a regression.
      const impSubject = jwtSub(impToken);
      test.skip(
        impSubject !== adminUserId,
        `impersonation resolved to user ${impSubject || "<unknown>"}, not ${
          CREDENTIALS.tenantAdmin.username
        } (${adminUserId}) — the e2e tenant must hold exactly one ACTIVE TENANT_ADMIN; run apps/api/scripts/e2e-seed.js`,
      );
      const impHeaders = { Authorization: `Bearer ${impToken}`, ...tenantHeaders };
      const nBefore = (
        (await (
          await page.request.get(`${api}/auth/sessions`, { headers: impHeaders })
        ).json()) as unknown[]
      ).length;
      expect(nBefore).toBeGreaterThanOrEqual(1);

      // 4. The menu: no "Sign out"; "Exit impersonation" lands on /admin/tenants.
      await page.getByRole("button", { name: "Open user menu" }).click();
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
      const exitItem = page.getByRole("menuitem", { name: "Exit impersonation" });
      await expect(exitItem).toBeVisible();
      await exitItem.click();
      await page.waitForURL("**/admin/tenants", { timeout: 30_000 });
      expect(await page.evaluate(() => localStorage.getItem("impersonationToken"))).toBeNull();
      expect(logoutCalls).toBe(0);

      // 5. Server-side truth through a token the UI never touched: nothing was revoked.
      const after = (await (
        await page.request.get(`${api}/auth/sessions`, { headers: impHeaders })
      ).json()) as { id: string }[];
      expect(after.length).toBe(nBefore);
      expect(after.some((s) => s.id === protectedSessionId)).toBe(true);
    } finally {
      await page.request
        .delete(`${api}/auth/sessions/${protectedSessionId}`, { headers: adminHeaders })
        .catch(() => null);
      await logout(page);
    }
  });
});
