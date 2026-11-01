/**
 * W1 "Make the trial real" (spec 82), project "trial-first-run".
 *
 * The whole path a new account takes: sign up on the form, verify from the mail the stack caught, land on the dashboard,
 * answer the one question, read the next steps and the Workspace ID, find the Workspace ID again on Settings, and confirm
 * the owner got the "new trial" mail. Then the same card at 768 and 390 with a different answer.
 *
 * Signed-out start, no storageState and no `setup` dependency: every test signs up its own `acme-trial-*` workspace (the public
 * sign-up refuses `e2e-*`/`qa-*` slugs on purpose; the owner allowed this one exception, local throwaway stack only, see
 * helpers/first-run-tenant.ts: the web, API and mail origins must all be loopback, and every write is checked by `assertWriteTarget`)
 * and reads the mail from the stack's mail catcher (MAILPIT_URL, default http://localhost:8025). The owner list is
 * E2E_OWNER_ALERT_EMAIL (default the code's `admin@routeflow.info`). Nothing here touches an existing tenant.
 */
import { test, expect, type Page } from "@playwright/test";
import { assertNoOverflow } from "./helpers/overflow";
import {
  adminToken,
  assertLocalStack,
  assertWriteTarget,
  apiOrigin,
  SIGNUP_THROWAWAY,
  newTrial,
  ownerAlertAddress,
  registerTrial,
  verifyAndLand,
  verificationPath,
  waitForMail,
  type NewTrial,
} from "./helpers/first-run-tenant";

const QUESTION = "How do orders reach your customers?";

async function firstRunStatus(page: Page, token: string) {
  const res = await page.request.get(
    `${apiOrigin(page.url())}/api/v1/settings/fulfilment/first-run`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(res.ok(), `GET first-run returned ${res.status()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** Status of an authenticated GET on the API (the tenant admin's token). */
async function apiStatus(page: Page, token: string, path: string) {
  const res = await page.request.get(`${apiOrigin(page.url())}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status();
}

/** The sidebar's Dispatch group (routes and drivers); it exists only for an account that delivers. */
const dispatchMenu = (page: Page) =>
  page.getByRole("navigation").getByText("Dispatch", { exact: true });

async function openQuestion(page: Page) {
  const card = page.getByTestId("first-run-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: QUESTION })).toBeVisible();
  return card;
}

test.describe("W1 — the first question on a new account", () => {
  // A retry would sign up again, and the public register route allows 5 a minute per address; this file uses 3.
  test.describe.configure({ retries: 0 });
  test.beforeEach(({ baseURL }) => assertLocalStack(baseURL));

  test("the write guard: only this test's own acme-trial sign-up passes, anything else must be an approved test tenant", () => {
    const mine = newTrial("1440");
    expect(mine.slug).toMatch(SIGNUP_THROWAWAY);
    expect(assertWriteTarget(mine.slug, mine)).toBe(mine.slug);
    // the approved test tenants pass with or without a sign-up
    for (const approved of [
      "test",
      "e2e-routeflow",
      "routeflow-demo",
      "qa-w1-alert",
      "e2e-first-run-x",
    ]) {
      expect(assertWriteTarget(approved)).toBe(approved);
    }
    // a throwaway nobody signed up here, another test's sign-up, a lookalike and a client-shaped name are all refused
    const other = newTrial("768");
    for (const [slug, signedUp] of [
      [mine.slug, undefined],
      [other.slug, mine],
      ["acme-trial", mine],
      ["acme-trial-1440", { slug: "acme-trial-1440" }],
      ["acme-distribution", { slug: "acme-distribution" }],
      ["acme-trial-1440-abc/../test", { slug: "acme-trial-1440-abc/../test" }],
    ] as const) {
      expect(() => assertWriteTarget(slug, signedUp), slug).toThrow(/not an approved test tenant/);
    }
  });

  test("1440: sign up, verify, answer, next steps, Workspace ID, owner mail", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const trial: NewTrial = newTrial("1440");

    // ── Sign up on the form ────────────────────────────────────────────────────
    await page.goto("/signup");
    await page.getByLabel("Business name").fill(trial.businessName);
    // The form derives the Workspace ID from the business name; what it shows is what the person signs in with.
    await expect(page.getByLabel("Workspace ID")).toHaveValue(trial.slug);
    await page.getByLabel("Email").fill(trial.email);
    // W2's form is four fields: Business name, Workspace ID, Email, Password. The username is suggested and
    // stays out of sight until it needs a person, so this sign-up takes the suggestion.
    await page.getByLabel("Password", { exact: true }).fill(trial.password);
    const create = page.getByRole("button", { name: "Create account" });
    assertWriteTarget(trial.slug, trial);
    await create.click();
    // The public register route allows 5 a minute per address: if an earlier run used them up, wait the window out once.
    const throttled = page.getByText(/too many requests/i);
    await expect(page.getByRole("heading", { name: "Check your inbox" }).or(throttled)).toBeVisible(
      { timeout: 30_000 },
    );
    if (await throttled.isVisible()) {
      await page.waitForTimeout(61_000);
      await create.click();
    }
    await page.waitForURL(/\/signup\/check-email/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    // ── Verify from the caught mail → the dashboard ───────────────────────────
    await page.goto(await verificationPath(request, trial));
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

    // The marker is pending: the card asks, and it is the one question on the screen.
    const card = await openQuestion(page);
    const token = await adminToken(page);
    expect(await firstRunStatus(page, token)).toMatchObject({
      state: "pending",
      workspaceId: trial.slug,
    });

    // F1 / F2: before the answer a new account has no routes add-on and no Dispatch menu.
    expect(await apiStatus(page, token, "/routes"), "GET /routes before the answer").toBe(403);
    await expect(dispatchMenu(page)).toHaveCount(0);

    // Nothing ticked → "Choose at least one." and the question stays open (no request is sent).
    await card.getByRole("button", { name: "Set up my account" }).click();
    await expect(card.getByText("Choose at least one.")).toBeVisible();
    expect((await firstRunStatus(page, token)).state).toBe("pending");

    // Delivery + counter → the account is set up and the card turns into the next steps.
    await card.getByLabel("We deliver with our own trucks").check();
    await card.getByLabel("Customers pick up or buy at the counter").check();
    assertWriteTarget(trial.slug, trial);
    await card.getByRole("button", { name: "Set up my account" }).click();

    const done = page.getByTestId("first-run-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done.getByRole("heading", { name: "Your account is ready." })).toBeVisible();
    await expect(done).toContainText(`Your Workspace ID is ${trial.slug}.`);
    for (const step of [
      "Add your products",
      "Add your customers",
      "Take your first order",
      "Add your business address",
      "Add a driver",
      "Plan your first route",
      "Start a counter sale",
    ]) {
      await expect(done.getByRole("link", { name: step })).toBeVisible();
    }
    await expect(page.getByTestId("first-run-card")).toHaveCount(0);

    // F2: Dispatch shows now, with NO reload (the answer re-reads the tenant's features). F1: the routes add-on is on.
    await expect(dispatchMenu(page)).toBeVisible();
    expect(await apiStatus(page, token, "/routes"), "GET /routes after the answer").toBe(200);

    // The server has it: answered, with exactly what was ticked, and a second answer is refused.
    expect(await firstRunStatus(page, token)).toMatchObject({
      state: "answered",
      workspaceId: trial.slug,
      delivery: true,
      counter: true,
      shipping: false,
      hasOrder: false,
    });
    assertWriteTarget(trial.slug, trial);
    const again = await page.request.post(
      `${apiOrigin(page.url())}/api/v1/settings/fulfilment/first-run`,
      { headers: { Authorization: `Bearer ${token}` }, data: { shipping: true } },
    );
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ code: "FIRST_RUN_CLOSED" });
    expect((await firstRunStatus(page, token)).shipping).toBe(false);

    // A reload keeps the answer: the next steps, not the question.
    await page.reload();
    await expect(page.getByTestId("first-run-done")).toContainText(trial.slug);
    await expect(page.getByTestId("first-run-card")).toHaveCount(0);

    // The Workspace ID is on Settings > Business profile too.
    await page.goto("/settings?tab=profile");
    const settingsId = page.getByTestId("settings-workspace-id");
    await expect(settingsId).toBeVisible({ timeout: 30_000 });
    await expect(settingsId).toContainText(trial.slug);
    await expect(settingsId).toContainText("You'll need it to sign in.");

    // The owner heard about the trial (the alert goes out when the email is verified).
    const alert = await waitForMail(
      request,
      ownerAlertAddress(),
      new RegExp(`New RouteFlow trial: ${trial.businessName}`),
    );
    expect(alert.text).toContain(`Workspace ID: ${trial.slug}`);
    expect(alert.text).toContain(`Contact email: ${trial.email}`);
  });

  for (const vp of [
    { name: "768", width: 768, height: 1024 },
    { name: "390", width: 390, height: 844 },
  ]) {
    test(`${vp.name}: the question and the next steps fit the screen (shipping only)`, async ({
      page,
      request,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const trial = newTrial(vp.name);
      await registerTrial(request, baseURL!, trial);
      await verifyAndLand(page, request, trial);

      const card = await openQuestion(page);
      await assertNoOverflow(page, `W1 question @${vp.name}`);

      await card.getByLabel("We ship by carrier").check();
      assertWriteTarget(trial.slug, trial);
      await card.getByRole("button", { name: "Set up my account" }).click();
      const done = page.getByTestId("first-run-done");
      await expect(done).toBeVisible({ timeout: 30_000 });
      await expect(done).toContainText(trial.slug);
      // Shipping only: no truck steps and no counter step; the three every account gets stay.
      await expect(done.getByRole("link", { name: "Add a driver" })).toHaveCount(0);
      await expect(done.getByRole("link", { name: "Start a counter sale" })).toHaveCount(0);
      await expect(done.getByRole("link", { name: "Take your first order" })).toBeVisible();
      await assertNoOverflow(page, `W1 next steps @${vp.name}`);
    });
  }
});
