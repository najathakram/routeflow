/**
 * Test kit: renders every platform-brand mail the B1 files produce, with fixed sample inputs, into
 * one `{ label: output }` map. The T-B5 fixture spec renders it under a fixture brand and scans
 * the output; a before/after run under the real brand proves a seam change altered no mail.
 * Sample data is placeholder-only (Acme). Not compiled into `dist/` (`**\/testing/**` is excluded).
 */
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import * as signedToken from "../common/signed-token";
import { DemoBookingService } from "../demo-booking/demo-booking.service";
import { OnboardingIntakeService } from "../onboarding/onboarding-intake.service";
import { OnboardingLifecycleService } from "../onboarding/onboarding-lifecycle.service";
import { portalInviteEmail } from "../customers/portal-invite-email";
import { EmailChannelProvider } from "../messaging/providers/email-channel.provider";
import { mailboxRevokedCopy, mailboxThrottledCopy } from "../email/mailbox/mailbox-alert.copy";
import {
  dunningTemplate,
  cancelledTemplate,
  checkoutPlanNotAppliedTemplate,
  downgradeAppliedTemplate,
  downgradeScheduledTemplate,
  rfInvoiceEmail,
  suspendedTemplate,
  trialEndingTemplate,
  upgradeConfirmedTemplate,
  type DunningEmailKind,
} from "../billing/billing-notification.templates";
import {
  brandHeaderHtml,
  renderBrandedEmail,
  renderEmailLayout,
  tenantHeaderHtml,
  wrapUnbrandedHtml,
} from "../email/email-layout";
import {
  newLoginMessage,
  passwordResetMessage,
  passwordSetMessage,
  routeflowFragmentMail,
  routeflowNotice,
  signInLinkedMessage,
  verifyEmailMessage,
} from "../email/routeflow-mail";
import { EmailService } from "../email/email.service";

type Out = Record<string, string>;
type Sent = { to?: string; subject: string; html: string; text?: string; from?: string };

function emailService(env: Record<string, string | undefined>): EmailService {
  const config = { get: (k: string) => env[k] } as never;
  const prisma = {
    getTenantId: () => null,
    forTenant: () => ({ systemConfig: { findMany: jest.fn(), findFirst: jest.fn() } }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as never;
  return new EmailService(
    config,
    prisma,
    { decrypt: (v: string) => v } as never,
    { trySend: jest.fn() } as never,
    { record: jest.fn() } as never,
    {} as never,
  );
}

const put = (out: Out, label: string, m: { subject?: string; html: string; text?: string }) => {
  if (m.subject !== undefined) out[`${label}#subject`] = m.subject;
  out[`${label}#html`] = m.html;
  if (m.text !== undefined) out[`${label}#text`] = m.text;
};

/** Every platform-brand mail and the From values, rendered with whatever brand is loaded. */
export async function renderPlatformMails(): Promise<Out> {
  const out: Out = {};

  // routeflow-mail.ts builders
  const verify = {
    verifyUrl: "https://app.test/v?t=1",
    webUrl: "https://app.test/",
    workspaceId: "acme",
    businessName: "Acme Foods",
  };
  put(out, "verify", verifyEmailMessage(verify));
  put(out, "verify-resend", verifyEmailMessage({ ...verify, resendFor: { username: "sam" } }));
  put(out, "reset", passwordResetMessage({ resetUrl: "https://app.test/r?t=1" }));
  put(
    out,
    "reset-tenant",
    passwordResetMessage({ resetUrl: "https://app.test/r?t=1", tenantName: "Acme Foods" }),
  );
  for (const provider of ["Google", "Apple"] as const) {
    for (const portal of [true, false]) {
      put(
        out,
        `signin-linked-${provider}-${portal}`,
        signInLinkedMessage({ provider, address: "a@acme.test", portal }),
      );
    }
  }
  put(out, "new-login", newLoginMessage({ device: "Phone", ip: "203.0.113.5", time: "now" }));
  for (const portal of [true, false]) {
    put(
      out,
      `password-set-${portal}`,
      passwordSetMessage({ portal, ip: "203.0.113.5", time: "now" }),
    );
  }
  put(
    out,
    "notice",
    routeflowNotice({
      subject: "S",
      heading: "H",
      lines: ["one", ["a ", { b: "b" }]],
      cta: { label: "Go", url: "https://app.test/x" },
      why: "Because.",
    }),
  );
  put(
    out,
    "fragment",
    routeflowFragmentMail({ subject: "S", heading: "H", bodyHtml: "<p>hi</p>", why: "Because." }),
  );

  // layout looks
  out["header-own"] = brandHeaderHtml();
  out["header-tenant"] = tenantHeaderHtml("Acme Foods");
  const body = { heading: "H", bodyHtml: "<p>x</p>", bodyText: ["x"], footerNote: "Note." };
  put(out, "layout-own", renderEmailLayout({ look: { kind: "routeflow" }, ...body }));
  put(
    out,
    "layout-tenant",
    renderEmailLayout({
      look: { kind: "tenant", name: "Acme Foods", color: "#336699" },
      cta: { label: "Go", url: "https://app.test/x" },
      ...body,
    }),
  );
  put(
    out,
    "layout-tenant-logo",
    renderEmailLayout({
      look: { kind: "tenant", name: "Acme Foods", logoUrl: "https://cdn.test/l.png" },
      ...body,
    }),
  );
  put(out, "layout-neutral", renderEmailLayout({ look: { kind: "neutral" }, ...body }));
  put(out, "branded-own", renderBrandedEmail({ ...body }));
  put(
    out,
    "branded-tenant",
    renderBrandedEmail({ look: { kind: "tenant", name: "Acme Foods" }, ...body }),
  );
  out["wrap-neutral"] = wrapUnbrandedHtml({
    look: { kind: "neutral" },
    subject: "S",
    html: "<p>x</p>",
    footerNote: "N",
  });
  out["wrap-tenant"] = wrapUnbrandedHtml({
    look: { kind: "tenant", name: "Acme Foods" },
    subject: "S",
    html: "<p>x</p>",
    footerNote: "N",
  });

  // EmailService: platform templates (send / sendPlatform captured), From values, UI message
  const sent: Array<{ via: string; p: Sent }> = [];
  const svc = emailService({
    SMTP_HOST: "h",
    SMTP_USER: "u@send.test",
    SMTP_PASS: "p",
    EMAIL_FROM: "RouteFlow <invoices@send.routeflow.info>",
    WEB_URL: "https://app.test",
  });
  (svc as never as { send: unknown }).send = jest.fn(
    (p: Sent) => (
      sent.push({ via: "send", p }),
      Promise.resolve({ delivered: true, transport: "smtp", smtpFallbackReason: "refused" })
    ),
  );
  (svc as never as { sendPlatform: unknown }).sendPlatform = jest.fn(
    (p: Sent) => (
      sent.push({ via: "sendPlatform", p }),
      Promise.resolve({ delivered: true, transport: "smtp" })
    ),
  );
  const call = async (name: string, fn: () => Promise<unknown>) => {
    const from = sent.length;
    await fn();
    sent.slice(from).forEach((s, i) => put(out, `svc-${name}${i ? `-${i}` : ""}`, s.p));
  };
  const to = "a@acme.test";
  const url = "https://app.test/x";
  await call("merge-verify", () =>
    svc.sendMergeVerificationEmail({ to, primaryEmail: "b@acme.test", verifyUrl: url }),
  );
  await call("merge-complete", () =>
    svc.sendMergeCompleteEmail({
      primaryEmail: to,
      secondaryEmail: "b@acme.test",
      primaryName: "Sam",
    }),
  );
  await call("set-password", () =>
    svc.sendSetPasswordEmail({ to, username: "sam", setPasswordUrl: url, expiryHours: 24 }),
  );
  for (const payUrl of [null, "https://app.test/pay"]) {
    await call(`welcome-${payUrl ? "pay" : "nopay"}`, () =>
      svc.sendTenantWelcomeEmail({
        to,
        username: "sam",
        businessName: "Acme Foods",
        workspace: "acme",
        setPasswordUrl: url,
        expiryHours: 24,
        loginUrl: "https://app.test/login",
        payUrl,
        trialDays: 14,
      }),
    );
  }
  await call("email-changed", () =>
    svc.sendEmailChangedNotice({ to, username: "sam", newEmail: "n@acme.test" }),
  );
  await call("email-change-confirmation", () =>
    svc.sendEmailChangeConfirmation({ to, username: "sam" }),
  );
  await call("email-change-link", () =>
    svc.sendEmailChangeLink({ to, username: "sam", confirmUrl: url, expiryHours: 24 }),
  );
  await call("email-change-requested", () =>
    svc.sendEmailChangeRequestedNotice({ to, username: "sam", maskedNewEmail: "n***@acme.test" }),
  );
  await call("role-changed", () =>
    svc.sendRoleChangedNotice({
      to,
      username: "sam",
      oldRole: "OPERATOR",
      newRole: "ADMIN",
      changedBy: "Kim",
    }),
  );
  for (const provider of ["GOOGLE", "MICROSOFT"] as const) {
    for (const hasFallback of [true, false]) {
      await call(`mailbox-revoked-${provider}-${hasFallback}`, () =>
        svc.sendMailboxRevokedNotice({
          to,
          username: "sam",
          accountEmail: "m@acme.test",
          provider,
          hasFallback,
        }),
      );
    }
  }
  await call("low-stock-named", () =>
    svc.sendLowStockDigest({
      to,
      businessName: "Acme Foods",
      items: [{ name: "Widget", sku: "W1", currentStock: 1, reorderPoint: 5 }],
    }),
  );
  await call("low-stock-unnamed", () =>
    svc.sendLowStockDigest({
      to,
      businessName: null,
      items: [{ name: "Widget", sku: null, currentStock: 1, reorderPoint: 5 }],
    }),
  );
  const test = await svc.sendTestEmail(to);
  out["svc-test-message"] = test.message;
  put(out, "svc-test-email", sent[sent.length - 1].p);
  out["ensure-layout-neutral"] = (
    await (
      svc as never as { ensureLayout: (p: unknown, t: boolean) => Promise<{ html: string }> }
    ).ensureLayout({ html: "<p>x</p>", subject: "S" }, false)
  ).html;
  out["ensure-layout-tenant"] = (
    await (
      svc as never as { ensureLayout: (p: unknown, t: boolean) => Promise<{ html: string }> }
    ).ensureLayout({ html: "<p>x</p>", subject: "S" }, true)
  ).html;
  out["business-name-default"] = await svc.getTenantBusinessName();
  const peek = (s: EmailService) =>
    s as never as { platformFrom: string; getPlatformSmtpFrom(): Promise<string> };
  out["from-env"] = peek(svc).platformFrom;
  out["from-env-bare"] = peek(
    emailService({ EMAIL_FROM: "invoices@send.routeflow.info" }),
  ).platformFrom;
  out["from-default"] = peek(emailService({})).platformFrom;
  out["from-smtp-no-env"] = peek(
    emailService({ SMTP_HOST: "h", SMTP_USER: "u@send.test", SMTP_PASS: "p" }),
  ).platformFrom;
  // "<Biz> via <Name>": a tenant-scoped platform-SMTP From
  const viaSvc = emailService({
    SMTP_HOST: "h",
    SMTP_USER: "u@send.test",
    SMTP_PASS: "p",
    EMAIL_FROM: "RouteFlow <invoices@send.routeflow.info>",
  });
  (viaSvc as never as { prisma: unknown }).prisma = {
    getTenantId: () => "t1",
    tenantConfig: { findFirst: jest.fn().mockResolvedValue({ businessName: "Acme Foods" }) },
  };
  out["from-via"] = await peek(viaSvc).getPlatformSmtpFrom();

  // billing-notification.templates
  const biz = { businessName: "Acme Foods", adminName: "Sam" };
  const prevWeb = process.env.WEB_URL;
  const prevFrontend = process.env.FRONTEND_URL;
  delete process.env.WEB_URL;
  delete process.env.FRONTEND_URL;
  for (const milestone of ["TRIAL_ENDING_7D", "TRIAL_ENDING_1D", "TRIAL_ENDING_EXPIRY"] as const) {
    put(
      out,
      `bill-trial-${milestone}`,
      trialEndingTemplate({ ...biz, milestone, trialEndsAt: "Jan 1" }),
    );
  }
  put(
    out,
    "bill-downgrade-scheduled",
    downgradeScheduledTemplate({
      ...biz,
      fromPlanName: "A",
      toPlanName: "B",
      effectiveAt: "Jan 1",
    }),
  );
  put(
    out,
    "bill-downgrade-applied",
    downgradeAppliedTemplate({ ...biz, fromPlanName: "A", toPlanName: "B" }),
  );
  put(
    out,
    "bill-upgrade",
    upgradeConfirmedTemplate({ ...biz, fromPlanName: "A", toPlanName: "B", proratedAmount: 12.5 }),
  );
  put(out, "bill-cancelled", cancelledTemplate(biz));
  put(out, "bill-suspended-a", suspendedTemplate({ ...biz, reason: "overdue payment" }));
  put(out, "bill-suspended-b", suspendedTemplate({ ...biz, reason: "subscription canceled" }));
  put(out, "bill-checkout-na", checkoutPlanNotAppliedTemplate({ ...biz, requestedPlanKey: "pro" }));
  const inv = {
    number: "INV-1",
    amount: 99,
    currency: "USD",
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-01-31T00:00:00Z"),
    dueDate: new Date("2026-02-01T00:00:00Z"),
    lines: [{ label: "Plan", quantity: 1, amount: 99 }],
  };
  for (const kind of ["manual", "issue", "d0", "d7", "d14"] as const) {
    put(out, `bill-rfinv-${kind}`, rfInvoiceEmail(kind, inv, "Acme Foods"));
  }
  for (const kind of [
    "d0",
    "d3",
    "d6",
    "final",
    "paused",
    "paused_still_owed",
  ] as DunningEmailKind[]) {
    put(
      out,
      `bill-dunning-${kind}`,
      dunningTemplate({
        kind,
        ...biz,
        payUrl: null,
        readOnlyOn: "Jan 9",
        byDate: "Jan 5",
        invoiceNumber: "INV-1",
        amountCents: 4900,
        currency: "usd",
      }),
    );
  }
  process.env.WEB_URL = "https://app.test";
  put(
    out,
    "bill-trial-env",
    trialEndingTemplate({ ...biz, milestone: "TRIAL_ENDING_7D", trialEndsAt: "Jan 1" }),
  );
  if (prevWeb === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = prevWeb;
  if (prevFrontend === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = prevFrontend;

  // buyer-auth mails
  const buyerSent: Sent[] = [];
  const buyer = new BuyerAuthService(
    {
      buyerEmailVerificationToken: { deleteMany: jest.fn(), create: jest.fn() },
      buyerPasswordResetToken: { deleteMany: jest.fn(), create: jest.fn() },
      buyerAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "b1", email: "b@acme.test", status: "ACTIVE", deletedAt: null }),
      },
    } as never,
    {} as never,
    { get: () => ({ web: "https://app.test" }) } as never,
    {
      send: jest.fn(
        (p: Sent) => (buyerSent.push(p), Promise.resolve({ delivered: true, transport: "smtp" })),
      ),
    } as never,
    {} as never,
  );
  await (
    buyer as never as { issueVerificationEmail(a: unknown): Promise<unknown> }
  ).issueVerificationEmail({ id: "b1", email: "b@acme.test" });
  await buyer.requestPasswordReset("b@acme.test");
  buyerSent.forEach((s, i) => put(out, `buyer-${i}`, s));

  await renderLaneB1bMails(out);

  return out;
}

/** The mail and strings of the launch-day files (lane B1b), rendered with fixed inputs. */
async function renderLaneB1bMails(out: Out): Promise<void> {
  const sent: Sent[] = [];
  const capture = {
    send: jest.fn((p: Sent) => (sent.push(p), Promise.resolve({ delivered: true }))),
    sendPlatform: jest.fn((p: Sent) => (sent.push(p), Promise.resolve({ delivered: true }))),
  };
  const drain = (label: string) => {
    sent.splice(0).forEach((m, i) => put(out, `${label}${i ? `-${i}` : ""}`, m));
  };
  const prevWeb = process.env.WEB_URL;
  const prevSecret = process.env.ONBOARDING_TOKEN_SECRET;
  delete process.env.WEB_URL;
  process.env.ONBOARDING_TOKEN_SECRET = "x".repeat(40);
  const mint = jest.spyOn(signedToken, "mintSignedToken").mockReturnValue("tok-1");
  const clock = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
  try {
    // demo-booking: both mails per kind (the site falls back to the brand's origin), the event
    const demo = new DemoBookingService({} as never, {} as never, capture as never);
    const booking = {
      id: "bk1",
      name: "Sam Buyer",
      email: "sam@acme.test",
      phone: "555-0100",
      company: "Acme Foods",
      notes: "Route planning",
      sourcePage: "/pricing",
      startsAt: new Date("2026-03-02T15:00:00Z"),
      endsAt: new Date("2026-03-02T15:30:00Z"),
      timeZone: "America/Chicago",
      status: "CONFIRMED",
      meetUrl: "https://meet.test/abc",
    };
    for (const kind of ["booked", "rescheduled", "cancelled"] as const) {
      await (
        demo as never as { sendConfirmation(...a: unknown[]): Promise<boolean> }
      ).sendConfirmation(booking, "mt-1", kind, { demoBookingAdminEmails: ["ops@acme.test"] });
      const [booker, admin] = sent.splice(0);
      put(out, `demo-booker-${kind}`, booker);
      put(out, `demo-admin-${kind}`, admin);
    }
    const shape = (demo as never as { eventShape(b: unknown): Record<string, unknown> }).eventShape(
      booking,
    );
    out["demo-event#subject"] = String(shape.summary);
    out["demo-event#text"] = String(shape.description);

    // onboarding intake: the link mail and the sent-back mail
    const intakeCase = {
      id: "c1",
      status: "OPEN",
      tenantId: null,
      contactEmail: "sam@acme.test",
      contactName: "Sam Buyer",
      companyName: "Acme Foods",
    };
    const tx = {
      $queryRaw: jest.fn(),
      intakeAccessToken: { updateMany: jest.fn(), create: jest.fn() },
      intakeSection: { update: jest.fn() },
    };
    const intake = new OnboardingIntakeService(
      {
        onboardingCase: { findUnique: jest.fn().mockResolvedValue(intakeCase) },
        $transaction: (cb: (t: unknown) => unknown) => cb(tx),
      } as never,
      { log: jest.fn() } as never,
      capture as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const priv = intake as never as Record<string, unknown>;
    priv.ensureSections = jest.fn();
    priv.event = jest.fn();
    priv.adminAudit = jest.fn();
    priv.lockSection = jest.fn().mockResolvedValue({ id: "s1", status: "SUBMITTED" });
    priv.adminView = jest.fn();
    await intake.issueLink("c1", "admin1", true);
    drain("intake-link");
    await intake.review("c1", "INVOICING", "request_changes", "Please confirm the tax id.", "a1");
    drain("intake-sentback");

    // onboarding lifecycle: the reminder
    const lifecycle = new OnboardingLifecycleService(
      {
        onboardingCase: {
          findMany: jest.fn().mockResolvedValue([
            {
              ...intakeCase,
              tokens: [
                {
                  id: "t1",
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                  expiresAt: new Date("2026-01-31T00:00:00Z"),
                  lastUsedAt: null,
                },
              ],
              sections: [
                { key: "INVOICING", status: "EMPTY" },
                { key: "TEAM", status: "DRAFT" },
              ],
            },
          ]),
        },
        onboardingEvent: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      } as never,
      capture as never,
      {} as never,
    );
    await lifecycle.sendReminders(new Date("2026-01-10T00:00:00Z"));
    drain("lifecycle-reminder");

    // buyer-portal invite, in the three looks
    for (const [name, look] of [
      ["tenant", { kind: "tenant", name: "Acme Foods", color: "#336699" }],
      ["neutral", { kind: "neutral" }],
      ["own", { kind: "routeflow" }],
    ] as const) {
      put(
        out,
        `portal-invite-${name}`,
        portalInviteEmail("Acme Foods", "https://app.test/i", look),
      );
    }

    // the messaging engine's EMAIL transport: default subject, then a given one, per look
    for (const [name, look, subject] of [
      ["default-tenant", { kind: "tenant", name: "Acme Foods" }, undefined],
      ["default-neutral", { kind: "neutral" }, undefined],
      ["given-subject", { kind: "neutral" }, "Order ready"],
    ] as const) {
      const send = jest.fn((p: Sent & { layout?: unknown }) => {
        put(out, `channel-${name}`, p);
        out[`channel-${name}#layout`] = JSON.stringify(p.layout);
        return Promise.resolve({ delivered: true, transport: "smtp" });
      });
      await new EmailChannelProvider({ tenantLook: async () => look, send } as never).send({
        channel: "EMAIL",
        to: "a@acme.test",
        subject,
        body: "Your order is ready.\nThanks.",
      } as never);
    }

    // mailbox alert copy
    for (const provider of ["GOOGLE", "MICROSOFT"] as const) {
      for (const hasFallback of [true, false]) {
        const c = mailboxRevokedCopy({ accountEmail: "m@acme.test", provider, hasFallback });
        const label = `mailalert-revoked-${provider}-${hasFallback}`;
        out[`${label}#subject`] = c.subject;
        out[`${label}#text`] = [c.heading, ...c.paragraphs, c.cta].join("\n");
        out[`${label}-inapp#text`] = `${c.inApp.title}\n${c.inApp.body}`;
        const t = mailboxThrottledCopy({
          accountEmail: "m@acme.test",
          provider,
          throttledUntil: new Date("2026-01-01T02:00:00Z"),
          hasFallback,
          now: new Date("2026-01-01T00:00:00Z"),
        });
        out[`mailalert-throttled-${provider}-${hasFallback}#text`] =
          `${t.inApp.title}\n${t.inApp.body}`;
      }
    }
  } finally {
    mint.mockRestore();
    clock.mockRestore();
    if (prevWeb === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = prevWeb;
    if (prevSecret === undefined) delete process.env.ONBOARDING_TOKEN_SECRET;
    else process.env.ONBOARDING_TOKEN_SECRET = prevSecret;
  }
}
