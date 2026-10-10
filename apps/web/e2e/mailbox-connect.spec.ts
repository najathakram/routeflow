/**
 * F-10b (#2078): Settings → Email → "Connect your email" (MailboxCard) in a real browser, on the
 * real web build, signed in as the seeded tenant admin. THE PROVIDER IS ALWAYS STUBBED:
 *   - every mailbox endpoint (`/settings/email/mailbox`, `…/google/start`, `…/microsoft/start`,
 *     `…/confirm/:token/preview`, `…/confirm`, `…/confirm/cancel`) is answered by `page.route`,
 *     so no mailbox call ever reaches the API. The stubs hold the server's #2115 rules: preview
 *     and confirm are refused (403) unless they carry the connect secret `/start` issued;
 *   - the "consent screen" the start stub hands back lives on `oauth-provider.invalid` (RFC 2606:
 *     `.invalid` can never resolve), which is route-stubbed too, answered 204 so the browser
 *     records the navigation and stays on the page;
 *   - a guard aborts and records any request to a real Google/Microsoft OAuth, Gmail or Graph
 *     host, and every test asserts that record is empty.
 * Nothing is written server-side. The only real API call let through is the read-only
 * GET /tenants/me/addons, whose answer gets the email.connected_mailbox add-on set or cleared.
 *
 * Covers test-plan §4 (local-assets/handoff/2026-09-22/email-test-plan.md): every card state at
 * 1440/768/390 with a screenshot each, Connect Gmail/Outlook (pending state + the exact redirect
 * target), the mailbox_error / admin-consent / Google-cancel returns, and Disconnect three ways.
 * #2115: the mailbox_confirm return opens an explicit "Connect <account> to this workspace?"
 * dialog (captured at 1440/768/390) that binds only on Confirm; Cancel burns the grant; the same
 * link opened in ANOTHER tab (no connect secret there) is refused without ever being previewed.
 *
 * Role: TENANT_ADMIN (pre-authenticated storageState; the email tab is admin-only). Tenant: the approved e2e-routeflow seed.
 * Needs the full stack for the signed-in shell, so it runs where a compose slot exists or
 * against a deployed target, never on a host without one. Not in the local:e2e gate yet
 * (LOCAL-LANE.md): it joins after its first green run on a compose slot.
 */
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import type { MailboxConnectionStatus, MailboxProvider } from "@routeflow/types";
import { setTenantCookie } from "./helpers/auth";
import { requireBaseUrl } from "../lib/e2e-setup-guard";

const ADDON = "email.connected_mailbox";
const SETTINGS_EMAIL = "/settings?tab=email";
const FAKE_PROVIDER = "https://oauth-provider.invalid";
const STUB_STATE = "e2e-stub-state";
const CONFIRM_TOKEN = "e2e-fake-confirm-token";
/** What the start stubs hand the tab, per provider: the tab must present it again (#2115). */
const CONNECT_SECRETS = {
  google: "e2e-connect-secret-google",
  microsoft: "e2e-connect-secret-microsoft",
} as const;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

/** Real provider endpoints the browser must never reach from this spec. */
const REAL_PROVIDER =
  /^https:\/\/(accounts\.google\.com\/o\/oauth2|oauth2\.googleapis\.com|gmail\.googleapis\.com|login\.microsoftonline\.com|graph\.microsoft\.com)\//;

type MailboxStatus = {
  configured: boolean;
  googleConfigured: boolean;
  microsoftConfigured: boolean;
  connected: boolean;
  provider?: MailboxProvider;
  accountEmail?: string;
  status?: MailboxConnectionStatus;
  throttledUntil?: string | null;
  lastError?: string | null;
  lastSentAt?: string | null;
};

const NOT_CONNECTED: MailboxStatus = {
  configured: true,
  googleConfigured: true,
  microsoftConfigured: true,
  connected: false,
};
const CONNECTED_GOOGLE: MailboxStatus = {
  ...NOT_CONNECTED,
  connected: true,
  provider: "GOOGLE",
  accountEmail: "gmail-owner@acme.test",
  status: "CONNECTED",
  throttledUntil: null,
  lastError: null,
  lastSentAt: null,
};
const CONNECTED_MICROSOFT: MailboxStatus = {
  ...CONNECTED_GOOGLE,
  provider: "MICROSOFT",
  accountEmail: "outlook-owner@acme.test",
};
const GOOGLE_REVOKE_FAILED =
  "Couldn't confirm the disconnect with Google — revoke RouteFlow's access in your Google " +
  "account (myaccount.google.com/permissions), then try disconnecting again.";
const MS_DISCONNECTED =
  "Disconnected. Microsoft doesn't let RouteFlow revoke access on its own — remove RouteFlow " +
  "from your Microsoft account's app permissions (myaccount.microsoft.com → Privacy → Apps and " +
  "services, or account.live.com/consent/Manage for a personal account) to fully revoke it.";

/** The stubbed server, as each test drives it. */
interface Harness {
  addonHeld: boolean;
  /** What GET /settings/email/mailbox answers right now. */
  status: MailboxStatus;
  /** GET confirm/:token/preview's answer when the right secret comes with it; unset = 400. */
  previewAnswer?: { provider: MailboxProvider; accountEmail: string };
  /** POST /confirm's answer (it also becomes the status from then on); unset = abort. */
  confirmAnswer?: MailboxStatus;
  /** DELETE's answer, plus the status the server holds afterwards; unset = abort. */
  disconnectAnswer?: { body: { deleted: boolean; message?: string }; after: MailboxStatus };
  /** The connect secret the last start stub handed out: preview and confirm need it back. */
  issuedSecret: string | null;
  addonsAnswered: number;
  statusGets: number;
  deletes: number;
  starts: string[];
  previews: Array<{ token: string; secret: string | undefined }>;
  confirmBodies: unknown[];
  confirmSecrets: Array<string | undefined>;
  cancels: unknown[];
  providerNavigations: string[];
  realProviderHits: string[];
  /** The start stubs answer only once this resolves (tests hold it to see the pending state). */
  startGate: Promise<void>;
}

function newHarness(): Harness {
  return {
    addonHeld: true,
    status: NOT_CONNECTED,
    issuedSecret: null,
    addonsAnswered: 0,
    statusGets: 0,
    deletes: 0,
    starts: [],
    previews: [],
    confirmBodies: [],
    confirmSecrets: [],
    cancels: [],
    providerNavigations: [],
    realProviderHits: [],
    startGate: Promise.resolve(),
  };
}

function corsHeaders(route: Route): Record<string, string> {
  const origin = route.request().headers()["origin"];
  return origin
    ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" }
    : {};
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(route),
    body: JSON.stringify(body),
  });
}

/** The connect secret a stubbed preview/confirm request carries (a header, never the URL). */
const secretOf = (route: Route): string | undefined =>
  route.request().headers()["x-mailbox-connect-secret"];

/** A CORS preflight for a stubbed route, answered here so it never reaches the API. */
async function answerPreflight(route: Route) {
  const h = route.request().headers();
  await route.fulfill({
    status: 204,
    headers: {
      ...corsHeaders(route),
      "access-control-allow-methods": h["access-control-request-method"] ?? "GET, POST, DELETE",
      "access-control-allow-headers":
        h["access-control-request-headers"] ?? "authorization, content-type, x-tenant-slug",
    },
  });
}

async function installStubs(page: Page, h: Harness) {
  await page.route(REAL_PROVIDER, async (route) => {
    h.realProviderHits.push(route.request().url());
    await route.abort("blockedbyclient");
  });

  await page.route(`${FAKE_PROVIDER}/**`, async (route) => {
    h.providerNavigations.push(route.request().url());
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/v1/tenants/me/addons", async (route) => {
    if (route.request().method() === "OPTIONS") return answerPreflight(route);
    const response = await route.fetch();
    const body = (await response.json()) as { addons?: string[] };
    const others = (body.addons ?? []).filter((a) => a !== ADDON);
    h.addonsAnswered += 1;
    await route.fulfill({
      response,
      json: { ...body, addons: h.addonHeld ? [...others, ADDON] : others },
    });
  });

  await page.route("**/api/v1/settings/email/mailbox", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return answerPreflight(route);
    if (method === "GET") {
      h.statusGets += 1;
      return fulfillJson(route, h.status);
    }
    if (method === "DELETE" && h.disconnectAnswer) {
      h.deletes += 1;
      h.status = h.disconnectAnswer.after;
      return fulfillJson(route, h.disconnectAnswer.body);
    }
    await route.abort("failed");
  });

  for (const provider of ["google", "microsoft"] as const) {
    await page.route(`**/api/v1/settings/email/mailbox/${provider}/start`, async (route) => {
      if (route.request().method() === "OPTIONS") return answerPreflight(route);
      h.starts.push(provider);
      await h.startGate;
      h.issuedSecret = CONNECT_SECRETS[provider];
      await fulfillJson(route, {
        url: `${FAKE_PROVIDER}/${provider}/authorize?state=${STUB_STATE}`,
        connectSecret: CONNECT_SECRETS[provider],
      });
    });
  }

  await page.route("**/api/v1/settings/email/mailbox/confirm/*/preview", async (route) => {
    if (route.request().method() === "OPTIONS") return answerPreflight(route);
    const token = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const secret = secretOf(route);
    h.previews.push({ token, secret });
    if (!h.previewAnswer) return fulfillJson(route, { message: "state_invalid" }, 400);
    if (!secret || secret !== h.issuedSecret) {
      return fulfillJson(route, { message: "mailbox_connect_secret_mismatch" }, 403);
    }
    await fulfillJson(route, h.previewAnswer);
  });

  await page.route("**/api/v1/settings/email/mailbox/confirm", async (route) => {
    if (route.request().method() === "OPTIONS") return answerPreflight(route);
    h.confirmBodies.push(route.request().postDataJSON());
    const secret = secretOf(route);
    h.confirmSecrets.push(secret);
    if (!secret || secret !== h.issuedSecret) {
      return fulfillJson(route, { message: "mailbox_connect_secret_mismatch" }, 403);
    }
    if (!h.confirmAnswer) return route.abort("failed");
    h.status = h.confirmAnswer;
    await fulfillJson(route, h.confirmAnswer);
  });

  await page.route("**/api/v1/settings/email/mailbox/confirm/cancel", async (route) => {
    if (route.request().method() === "OPTIONS") return answerPreflight(route);
    h.cancels.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, headers: corsHeaders(route) });
  });
}

/** This tab starts a Gmail connect: /start hands it the connect secret, and it "leaves" for the
 *  stubbed consent screen, which answers 204, so the tab stays on the settings page. */
async function startGmailConnectInThisTab(page: Page) {
  await page.goto(SETTINGS_EMAIL);
  await card(page).getByRole("button", { name: "Connect Gmail" }).click();
  await expect.poll(() => h.providerNavigations).toHaveLength(1);
}

/** The toast viewport (Radix "Notifications" region): only real toasts, never the
 *  screen-reader announcer copy Radix renders elsewhere in the body. */
const toasts = (page: Page): Locator => page.getByRole("region", { name: /notifications/i });
const card = (page: Page): Locator => page.getByTestId("mailbox-card");

/** The Email tab rendered (its last section sits below the mailbox card). */
async function emailTabRendered(page: Page) {
  await expect(
    page.getByText("Optional — let RouteFlow send for you (verified domain)"),
  ).toBeVisible();
}

/** The dialog's open animation has finished (dialog and overlay), so a screenshot is not a mid-fade still:
 *  every finite animation on the page is done and the dialog is fully opaque. Infinite ones (spinners) are
 *  skipped: their `finished` never resolves. */
async function dialogSettled(page: Page, dialog: Locator) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await expect(dialog).toHaveCSS("opacity", "1");
}

/** Two animation frames: long enough for a resolved query to reach the DOM, so an absence
 *  asserted afterwards is not just "not rendered yet". */
async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

let h: Harness;

test.describe("Mailbox connect card (F-10b), provider always stubbed", () => {
  test.beforeEach(async ({ context, page }) => {
    await setTenantCookie(context, requireBaseUrl());
    h = newHarness();
    await installStubs(page, h);
  });

  test.afterEach(() => {
    expect(h.realProviderHits, "a real Google/Microsoft endpoint was requested").toEqual([]);
  });

  for (const vp of VIEWPORTS) {
    test(`every card state @${vp.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const shot = (state: string) =>
        page.screenshot({
          path: testInfo.outputPath(`mailbox-${state}-${vp.name}.png`),
          fullPage: true,
        });

      // not connected
      h.status = NOT_CONNECTED;
      await page.goto(SETTINGS_EMAIL);
      await expect(card(page).getByText("Connect your email")).toBeVisible();
      await expect(card(page).getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
      await expect(card(page).getByRole("button", { name: "Connect Outlook" })).toBeEnabled();
      await shot("not-connected");

      // CONNECTED, Google
      h.status = CONNECTED_GOOGLE;
      await page.goto(SETTINGS_EMAIL);
      await expect(card(page).getByText("gmail-owner@acme.test")).toBeVisible();
      await expect(card(page).getByText("Connected", { exact: true })).toBeVisible();
      await expect(card(page).getByText(/only `gmail\.send` is granted/)).toBeVisible();
      await expect(card(page).getByRole("button", { name: "Disconnect" })).toBeVisible();
      await shot("connected-google");

      // CONNECTED, Microsoft
      h.status = CONNECTED_MICROSOFT;
      await page.goto(SETTINGS_EMAIL);
      await expect(card(page).getByText("outlook-owner@acme.test")).toBeVisible();
      await expect(card(page).getByText("Connected", { exact: true })).toBeVisible();
      await expect(card(page).getByText(/only `Mail\.Send` is granted/)).toBeVisible();
      await shot("connected-microsoft");

      // THROTTLED
      h.status = {
        ...CONNECTED_GOOGLE,
        status: "THROTTLED",
        throttledUntil: "2030-01-01T15:00:00.000Z",
        lastError: "Rate-limited by Google — falling back to the next sender.",
      };
      await page.goto(SETTINGS_EMAIL);
      await expect(card(page).getByText("Rate-limited", { exact: true })).toBeVisible();
      await expect(card(page).getByText(/Rate-limited by Google until/)).toBeVisible();
      await shot("throttled");

      // REVOKED
      h.status = {
        ...CONNECTED_MICROSOFT,
        status: "REVOKED",
        lastError: "Microsoft rejected the send — reconnect required.",
      };
      await page.goto(SETTINGS_EMAIL);
      await expect(card(page).getByText("Reconnect needed")).toBeVisible();
      await expect(card(page).getByText(/Microsoft revoked access to this mailbox/)).toBeVisible();
      await expect(card(page).getByRole("button", { name: "Reconnect" })).toBeEnabled();
      await shot("revoked");

      // add-on not held: nothing renders, and the status is never even asked for
      h.addonHeld = false;
      h.status = CONNECTED_GOOGLE;
      const statusGetsBefore = h.statusGets;
      const addonsBefore = h.addonsAnswered;
      await page.goto(SETTINGS_EMAIL);
      await emailTabRendered(page);
      await expect.poll(() => h.addonsAnswered).toBeGreaterThan(addonsBefore);
      await settle(page);
      await expect(card(page)).toHaveCount(0);
      expect(h.statusGets).toBe(statusGetsBefore);
      await shot("addon-not-held");

      // configured:false: nothing renders, even with the status loaded
      h.addonHeld = true;
      h.status = {
        configured: false,
        googleConfigured: false,
        microsoftConfigured: false,
        connected: false,
      };
      const gets = h.statusGets;
      await page.goto(SETTINGS_EMAIL);
      await emailTabRendered(page);
      await expect.poll(() => h.statusGets).toBeGreaterThan(gets);
      await settle(page);
      await expect(card(page)).toHaveCount(0);
      await shot("not-configured");
    });
  }

  for (const [label, provider] of [
    ["Connect Gmail", "google"],
    ["Connect Outlook", "microsoft"],
  ] as const) {
    test(`${label}: asks ${provider}/start, reads "Redirecting…" while it waits, then sends the browser to exactly the URL the API returned`, async ({
      page,
    }) => {
      let release!: () => void;
      h.startGate = new Promise<void>((r) => {
        release = r;
      });
      await page.goto(SETTINGS_EMAIL);

      await card(page).getByRole("button", { name: label }).click();

      await expect(card(page).getByRole("button", { name: "Redirecting…" }).first()).toBeDisabled();
      await expect.poll(() => h.starts).toEqual([provider]);
      expect(h.providerNavigations).toEqual([]);

      release();

      await expect
        .poll(() => h.providerNavigations)
        .toEqual([`${FAKE_PROVIDER}/${provider}/authorize?state=${STUB_STATE}`]);
    });
  }

  for (const vp of VIEWPORTS) {
    test(`Connect Gmail, then back with mailbox_confirm @${vp.name}: the dialog names the account, and only Confirm binds it`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      h.status = NOT_CONNECTED;
      h.previewAnswer = { provider: "GOOGLE", accountEmail: "gmail-owner@acme.test" };
      h.confirmAnswer = CONNECTED_GOOGLE;
      await startGmailConnectInThisTab(page);

      // The provider redirects the SAME tab back with a confirm token.
      await page.goto(`${SETTINGS_EMAIL}&mailbox_confirm=${CONFIRM_TOKEN}`);

      const dialog = page.getByRole("dialog", {
        name: "Connect gmail-owner@acme.test to this workspace?",
      });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(/\/settings\?tab=email$/);
      expect(h.previews).toEqual([{ token: CONFIRM_TOKEN, secret: CONNECT_SECRETS.google }]);
      expect(h.confirmBodies).toEqual([]);
      await dialogSettled(page, dialog);
      await page.screenshot({ path: testInfo.outputPath(`mailbox-confirm-dialog-${vp.name}.png`) });

      await dialog.getByRole("button", { name: "Confirm" }).click();

      await expect(toasts(page).getByText("Gmail mailbox connected")).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(card(page).getByText("gmail-owner@acme.test")).toBeVisible();
      await expect(card(page).getByText("Connected", { exact: true })).toBeVisible();
      expect(h.confirmBodies).toEqual([{ state: CONFIRM_TOKEN }]);
      expect(h.confirmSecrets).toEqual([CONNECT_SECRETS.google]);
      expect(h.cancels).toEqual([]);
    });
  }

  test("Cancel in the confirm dialog burns the grant and binds nothing", async ({ page }) => {
    h.status = NOT_CONNECTED;
    h.previewAnswer = { provider: "GOOGLE", accountEmail: "gmail-owner@acme.test" };
    await startGmailConnectInThisTab(page);
    await page.goto(`${SETTINGS_EMAIL}&mailbox_confirm=${CONFIRM_TOKEN}`);

    const dialog = page.getByRole("dialog", { name: /to this workspace\?$/ });
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText("Gmail not connected")).toBeVisible();
    await expect.poll(() => h.cancels).toEqual([{ state: CONFIRM_TOKEN }]);
    expect(h.confirmBodies).toEqual([]);
    await expect(card(page).getByRole("button", { name: "Connect Gmail" })).toBeVisible();
  });

  test("the confirm link opened in ANOTHER tab (no connect secret there): never previewed, burned, nothing binds", async ({
    page,
    context,
  }) => {
    h.status = NOT_CONNECTED;
    h.previewAnswer = { provider: "GOOGLE", accountEmail: "gmail-owner@acme.test" };
    h.confirmAnswer = CONNECTED_GOOGLE;
    // This tab starts the connect and holds the secret...
    await startGmailConnectInThisTab(page);

    // ...but the confirm link is opened in a different tab: same admin, same JWT, no secret.
    const otherTab = await context.newPage();
    await installStubs(otherTab, h);
    await otherTab.goto(`${SETTINGS_EMAIL}&mailbox_confirm=${CONFIRM_TOKEN}`);

    await expect(toasts(otherTab).getByText("Mailbox not connected")).toBeVisible();
    await expect(
      toasts(otherTab).getByText(/only be confirmed in the browser tab where it was started/),
    ).toBeVisible();
    await expect.poll(() => h.cancels).toEqual([{ state: CONFIRM_TOKEN }]);
    await expect(otherTab.getByRole("dialog")).toHaveCount(0);
    expect(h.previews).toEqual([]);
    expect(h.confirmBodies).toEqual([]);
    await otherTab.close();
  });

  test("mailbox_error return: the generic couldn't-connect toast, nothing confirmed, flag stripped", async ({
    page,
  }) => {
    await page.goto(`${SETTINGS_EMAIL}&mailbox_error=1`);

    await expect(toasts(page).getByText("Couldn't connect the mailbox")).toBeVisible();
    await expect(
      toasts(page).getByText("The provider didn't complete the connection — try again."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?tab=email$/);
    expect(h.confirmBodies).toEqual([]);
  });

  test("mailbox_admin_consent_required return: its own copy, naming the organisation's Microsoft 365 admin", async ({
    page,
  }) => {
    await page.goto(`${SETTINGS_EMAIL}&mailbox_admin_consent_required=1`);

    await expect(toasts(page).getByText("Your organisation requires admin approval")).toBeVisible();
    await expect(
      toasts(page).getByText(/ask a Microsoft 365 admin to grant consent, then try again/),
    ).toBeVisible();
    await expect(toasts(page).getByText("Couldn't connect the mailbox")).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\?tab=email$/);
  });

  for (const vp of VIEWPORTS) {
    test(`mailbox_cancelled=google return @${vp.name}: says the user cancelled and nothing changed, not an error`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      h.status = NOT_CONNECTED;

      await page.goto(`${SETTINGS_EMAIL}&mailbox_cancelled=google`);

      await expect(toasts(page).getByText("Gmail connection cancelled")).toBeVisible();
      await expect(
        toasts(page).getByText("You cancelled connecting Gmail; nothing was changed."),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`mailbox-cancelled-toast-${vp.name}.png`),
      });
      await expect(toasts(page).getByText("Couldn't connect the mailbox")).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings\?tab=email$/);
      await expect(card(page).getByRole("button", { name: "Connect Gmail" })).toBeVisible();
      expect(h.confirmBodies).toEqual([]);
    });
  }

  test("Disconnect, Google revoked at Google: success toast, card back to not connected", async ({
    page,
  }) => {
    h.status = CONNECTED_GOOGLE;
    h.disconnectAnswer = { body: { deleted: true }, after: NOT_CONNECTED };
    await page.goto(SETTINGS_EMAIL);

    await card(page).getByRole("button", { name: "Disconnect" }).click();

    await expect(toasts(page).getByText("Gmail mailbox disconnected")).toBeVisible();
    await expect(card(page).getByText("Connect your email")).toBeVisible();
    await expect(card(page).getByText("gmail-owner@acme.test")).toHaveCount(0);
    expect(h.deletes).toBe(1);
  });

  test("Disconnect, Google revoke failed ({deleted:false}): a warning with the server's instruction, and the kept connection still shows", async ({
    page,
  }) => {
    h.status = CONNECTED_GOOGLE;
    h.disconnectAnswer = {
      body: { deleted: false, message: GOOGLE_REVOKE_FAILED },
      after: { ...CONNECTED_GOOGLE, status: "REVOKED", lastError: GOOGLE_REVOKE_FAILED },
    };
    await page.goto(SETTINGS_EMAIL);

    await card(page).getByRole("button", { name: "Disconnect" }).click();

    await expect(toasts(page).getByText("Couldn't fully disconnect")).toBeVisible();
    await expect(toasts(page).getByText(GOOGLE_REVOKE_FAILED)).toBeVisible();
    await expect(card(page).getByText("Reconnect needed")).toBeVisible();
    await expect(card(page).getByText("gmail-owner@acme.test")).toBeVisible();
    await expect(card(page).getByText("Connect your email")).toHaveCount(0);
  });

  test("Disconnect, Microsoft: the success toast still tells the admin to remove RouteFlow at Microsoft", async ({
    page,
  }) => {
    h.status = CONNECTED_MICROSOFT;
    h.disconnectAnswer = {
      body: { deleted: true, message: MS_DISCONNECTED },
      after: NOT_CONNECTED,
    };
    await page.goto(SETTINGS_EMAIL);

    await card(page).getByRole("button", { name: "Disconnect" }).click();

    await expect(toasts(page).getByText("Outlook mailbox disconnected")).toBeVisible();
    await expect(
      toasts(page).getByText(/remove RouteFlow from your Microsoft account's app permissions/),
    ).toBeVisible();
    await expect(card(page).getByText("Connect your email")).toBeVisible();
  });
});
