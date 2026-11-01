import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * W1 (spec 82): helpers for a brand-new trial account: a throwaway `acme-trial-*` workspace, the mail the stack caught for it
 * (mailpit), and the owner's alert list.
 *
 * WHY NOT AN `e2e-*` SLUG: the public sign-up refuses every approved test-tenant slug on purpose (tenants.service.ts, row 195:
 * a real sign-up can never land on a test tenant), and only `register()` writes the first-question marker. So this spec creates
 * its own tenants by signing up, and the safety is the target instead: `assertLocalStack` refuses to run unless the web, API
 * and mail origins are all loopback (the project is also registered only for a local base URL). Never point it at a hosted stack.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws unless the web origin, the API origin and the mail catcher are all on this machine. */
export function assertLocalStack(webURL: string | undefined): void {
  const origins = [webURL ?? "", apiOrigin(webURL ?? "http://invalid.invalid"), mailpitBase()];
  for (const o of origins) {
    let host = "";
    try {
      host = new URL(o).hostname;
    } catch {
      /* falls through to the refusal below */
    }
    if (!LOOPBACK.has(host)) {
      throw new Error(
        `spec 82 signs up real workspaces and only runs against a local stack; refusing ${JSON.stringify(o)}.`,
      );
    }
  }
}

/** The local mail catcher (compose `mailpit`, UI + API on :8025; a lane's own stack sets MAILPIT_URL). */
export function mailpitBase(): string {
  return (process.env.MAILPIT_URL ?? "http://localhost:8025").replace(/\/+$/, "");
}

/** Where the owner's alerts go: `DEMO_BOOKING_ADMIN_EMAIL`'s first address, else the code default. */
export function ownerAlertAddress(): string {
  return (process.env.E2E_OWNER_ALERT_EMAIL ?? "admin@routeflow.info").trim();
}

/** The API origin: SMOKE_BASE_URL (the `--e2e` wrapper sets it), else the web origin with its port swapped. */
export function apiOrigin(webURL: string): string {
  if (process.env.SMOKE_BASE_URL) return process.env.SMOKE_BASE_URL.replace(/\/+$/, "");
  return new URL(webURL).origin.replace(/:3001\b/, ":3000");
}

export interface NewTrial {
  /** The business name typed on the sign-up form. */
  businessName: string;
  /** The Workspace ID the form derives from it (and the account signs in with). */
  slug: string;
  email: string;
  username: string;
  password: string;
}

/** A fresh, unique trial identity. The slug is exactly what the sign-up form's slugify gives `businessName`. */
export function newTrial(label = "trial"): NewTrial {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const businessName = `Acme ${label} ${suffix}`;
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return {
    businessName,
    slug,
    // example.invalid never resolves; the stack's mail catcher is the only place this mail lands.
    email: `${slug}@example.invalid`,
    // Short on purpose: the shell top bar escapes the 768 viewport by 2px for a 26-character username (reported apart from W1).
    username: `tr_${suffix}`,
    password: "Trial-Pass-1234",
  };
}

/** Sign-up through the API (the sign-up form is driven once, in the long spec; the narrow-width specs start here). */
export async function registerTrial(request: APIRequestContext, webURL: string, t: NewTrial) {
  const post = () =>
    request.post(`${apiOrigin(webURL)}/api/v1/public/tenants/register`, {
      data: {
        slug: t.slug,
        businessName: t.businessName,
        adminEmail: t.email,
        adminUsername: t.username,
        adminPassword: t.password,
        timezone: "America/Chicago",
      },
    });
  let res = await post();
  if (res.status() === 429) {
    // The public register route allows 5 a minute per address: wait the window out once, then try again.
    await new Promise((r) => setTimeout(r, 61_000));
    res = await post();
  }
  expect(res.ok(), `register ${t.slug} returned ${res.status()}`).toBe(true);
  expect(((await res.json()) as { emailSent?: boolean }).emailSent).not.toBe(false);
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** The newest mail to `to` whose subject matches, polled until it arrives. Returns its subject and plain text. */
export async function waitForMail(
  request: APIRequestContext,
  to: string,
  subject: RegExp,
  timeoutMs = 30_000,
): Promise<{ subject: string; text: string }> {
  const base = mailpitBase();
  let found: { subject: string; text: string } | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        if (!res.ok()) return false;
        const list = ((await res.json()) as { messages?: MailSummary[] }).messages ?? [];
        const hit = list.find((m) => subject.test(m.Subject));
        if (!hit) return false;
        const body = await request.get(`${base}/api/v1/message/${hit.ID}`);
        if (!body.ok()) return false;
        const msg = (await body.json()) as { Text?: string; HTML?: string };
        found = { subject: hit.Subject, text: msg.Text ?? msg.HTML ?? "" };
        return true;
      },
      { message: `mail to ${to} matching ${subject}`, timeout: timeoutMs, intervals: [500, 1000] },
    )
    .toBe(true);
  return found!;
}

/** True when no mail to `to` matches `subject` (used to prove an alert did NOT go out). */
export async function noMail(request: APIRequestContext, to: string, subject: RegExp) {
  const res = await request.get(
    `${mailpitBase()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  const list = ((await res.json()) as { messages?: MailSummary[] }).messages ?? [];
  return !list.some((m) => subject.test(m.Subject));
}

/** The verify-email link the stack caught for `t`, as a path + query on the web origin. */
export async function verificationPath(request: APIRequestContext, t: NewTrial): Promise<string> {
  const mail = await waitForMail(request, t.email, /verify/i);
  const m = mail.text.match(/https?:\/\/[^\s"'<>]+\/verify-email\?token=[\w.-]+/);
  expect(m, `no verify-email link in the mail to ${t.email}`).not.toBeNull();
  const url = new URL(m![0]);
  return `${url.pathname}${url.search}`;
}

/** Follow the verification link: the page signs the admin in and lands on the dashboard. */
export async function verifyAndLand(page: Page, request: APIRequestContext, t: NewTrial) {
  await page.goto(await verificationPath(request, t));
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/** The signed-in admin's access token (the web app keeps it in localStorage), for read-only API checks. */
export async function adminToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () => localStorage.getItem("rf:op:accessToken") || localStorage.getItem("accessToken") || "",
  );
  expect(token, "the verified admin has an access token").not.toBe("");
  return token;
}
