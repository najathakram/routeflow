import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { resolveZone } from "../common/tenant-time-zone";
import { EmailService } from "../email/email.service";
import {
  trialEndingTemplate,
  downgradeScheduledTemplate,
  downgradeAppliedTemplate,
  upgradeConfirmedTemplate,
  cancelledTemplate,
  suspendedTemplate,
  checkoutPlanNotAppliedTemplate,
  rfInvoiceEmail,
  dunningTemplate,
  DunningEmailKind,
  TrialEndingMilestone,
  BillingEmailTemplate,
  RfInvoiceEmailInput,
  RfInvoiceEmailKind,
} from "./billing-notification.templates";

// N3 (2026-09-16): sends billing-lifecycle emails to the tenant admin(s), fail-closed and
// idempotent per (tenant, milestone[, key]) via BillingNotificationLog's unique constraint.
// Every public method here NEVER throws — a notification failure (claim error, missing
// admin, send failure) is logged and swallowed so the caller's business action (plan
// change, cancellation, suspension) always succeeds regardless of email outcome.

const isUniqueViolation = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";

/** What one RF-invoice email attempt came to; `skipped` = an auto kind already claimed. */
export interface RfInvoiceDeliveryResult {
  status: "sent" | "no_recipients" | "failed" | "skipped";
  /** Admins who accepted the mail: a COUNT, never an address. */
  recipients: number;
}

interface AdminContact {
  email: string;
  name: string;
}

@Injectable()
export class BillingNotificationService {
  private readonly logger = new Logger(BillingNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Atomic idempotency claim: `create()` races the unique (tenantId, milestone, key)
   * constraint — a caught P2002 means this exact occurrence was already claimed (sending,
   * or already sent). Returns true only for the caller that WON the claim. Any OTHER
   * error (a dead/unreachable table, a transient connection drop) also returns false —
   * erring toward "don't send" under DB trouble is simpler and avoids a duplicate-under-
   * retry, and the business action this rides alongside never depends on the claim.
   */
  private async claim(tenantId: string, milestone: string, key: string): Promise<boolean> {
    try {
      await this.prisma.billingNotificationLog.create({ data: { tenantId, milestone, key } });
      return true;
    } catch (e) {
      if (!isUniqueViolation(e)) {
        this.logger.error(
          `billing-notification claim failed for ${tenantId}/${milestone}/${key}`,
          e as Error,
        );
      }
      return false;
    }
  }

  /**
   * Fix round (Opus review of 1dba2bca, finding 2): a claim is a promise "this got emailed",
   * not "this was attempted" — EmailService does not throw on failure, it returns
   * `{delivered:false}`. With no transport configured (or down) for even an hour, every
   * claimed notification would be silently lost forever, the row never released. Deleting the
   * claim on a failed/no-recipient send lets the NEXT cron tick or event retry it. Trade-off,
   * documented here: a release that itself fails (a race with another release, a DB hiccup)
   * can let a later retry double-send — "at most twice", never zero, which is the safer
   * failure direction for a billing notification.
   */
  private async release(tenantId: string, milestone: string, key: string): Promise<void> {
    try {
      await this.prisma.billingNotificationLog.delete({
        where: { tenantId_milestone_key: { tenantId, milestone, key } },
      });
    } catch (e) {
      this.logger.error(
        `billing-notification release failed for ${tenantId}/${milestone}/${key}`,
        e as Error,
      );
    }
  }

  /** Fix round (finding 8): every ACTIVE tenant admin, not just the first — a tenant can have
   *  more than one, and all of them should hear about a billing-lifecycle event. */
  private async adminsOf(tenantId: string): Promise<AdminContact[]> {
    const admins = await this.prisma.user.findMany({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      select: { email: true, username: true },
      orderBy: { createdAt: "asc" },
    });
    return admins
      .filter((a) => !!a.email)
      .map((a) => ({ email: a.email, name: a.username ?? a.email }));
  }

  private async businessNameOf(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    return tenant?.name ?? tenant?.slug ?? "your account";
  }

  /** Fix round (finding 9): display in the tenant's own timezone when it has a valid one (the one
   *  resolver, SA-738), else null so the date is UTC, explicitly labelled — display-only, never
   *  affects the underlying Date value or any idempotency key. */
  private async tenantTimezone(tenantId: string): Promise<string | null> {
    const { zone, fallback } = await resolveZone(this.prisma, { tenantId });
    return fallback ? null : zone;
  }

  private formatDate(d: Date, timezone: string | null): string {
    if (timezone) {
      try {
        return new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: timezone,
        }).format(d);
      } catch {
        // An invalid/unrecognised IANA zone stored on the tenant — fail safe to UTC below
        // rather than throw out of a notification path.
      }
    }
    return `${d.toISOString().slice(0, 10)} (UTC)`;
  }

  /** Sends one template per admin; returns how many admins there were and how many accepted the mail. */
  private async deliverToAdmins(
    tenantId: string,
    build: (
      admin: AdminContact,
      businessName: string,
      dateFor: (d: Date) => string,
    ) => BillingEmailTemplate,
  ): Promise<{ admins: number; delivered: number }> {
    const admins = await this.adminsOf(tenantId);
    if (!admins.length) return { admins: 0, delivered: 0 };
    const [businessName, timezone] = await Promise.all([
      this.businessNameOf(tenantId),
      this.tenantTimezone(tenantId),
    ]);
    const dateFor = (d: Date) => this.formatDate(d, timezone);
    let delivered = 0;
    for (const admin of admins) {
      const tmpl = build(admin, businessName, dateFor);
      const result = await this.email.sendPlatform({
        to: admin.email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
        ...(tmpl.replyTo ? { replyTo: tmpl.replyTo } : {}),
      });
      if (result.delivered) delivered++;
    }
    return { admins: admins.length, delivered };
  }

  private async sendIfClaimed(
    tenantId: string,
    milestone: string,
    key: string,
    build: (
      admin: AdminContact,
      businessName: string,
      dateFor: (d: Date) => string,
    ) => BillingEmailTemplate,
  ): Promise<RfInvoiceDeliveryResult> {
    try {
      const won = await this.claim(tenantId, milestone, key);
      if (!won) return { status: "skipped", recipients: 0 };
      const { admins, delivered } = await this.deliverToAdmins(tenantId, build);
      if (!admins) {
        // Nobody to notify right now - release so a later-added admin still gets it, same
        // "a claim is a promise it was DELIVERED" rule as a failed send below.
        await this.release(tenantId, milestone, key);
        return { status: "no_recipients", recipients: 0 };
      }
      if (!delivered) {
        await this.release(tenantId, milestone, key);
        return { status: "failed", recipients: 0 };
      }
      return { status: "sent", recipients: delivered };
    } catch (e) {
      this.logger.error(`billing-notification failed for ${tenantId}/${milestone}`, e as Error);
      return { status: "failed", recipients: 0 };
    }
  }

  /**
   * RouteFlow's own invoice to a manual-pay tenant's admins (manual invoices due). `manual` is a
   * super-admin resend: no claim, the caller's cooldown is the guard. Every other kind is claim-keyed
   * "<number>:issued" / "<number>:d0|d7|d14", so a rerun of the cron sends nothing. Never throws.
   */
  async sendRfInvoice(
    invoice: RfInvoiceEmailInput & { id: string; tenantId: string },
    kind: RfInvoiceEmailKind,
  ): Promise<RfInvoiceDeliveryResult> {
    const build = (_admin: AdminContact, businessName: string) =>
      rfInvoiceEmail(kind, invoice, businessName);
    if (kind === "manual") {
      try {
        const { admins, delivered } = await this.deliverToAdmins(invoice.tenantId, build);
        if (!admins) return { status: "no_recipients", recipients: 0 };
        return delivered
          ? { status: "sent", recipients: delivered }
          : { status: "failed", recipients: 0 };
      } catch (e) {
        this.logger.error(`rf invoice send failed for ${invoice.tenantId}`, e as Error);
        return { status: "failed", recipients: 0 };
      }
    }
    const suffix = kind === "issue" ? "issued" : kind;
    return this.sendIfClaimed(invoice.tenantId, "rf-invoice", `${invoice.number}:${suffix}`, build);
  }

  async notifyTrialEnding(
    tenantId: string,
    milestone: TrialEndingMilestone,
    trialEndsAt: Date,
  ): Promise<void> {
    // Fix round (finding 7): key = trialEndsAt, not a bare "" — an EXTENDED trial gets a new
    // trialEndsAt value and must re-warn, not read as "already sent" forever.
    await this.sendIfClaimed(
      tenantId,
      milestone,
      trialEndsAt.toISOString(),
      (admin, businessName, dateFor) =>
        trialEndingTemplate({
          businessName,
          adminName: admin.name,
          milestone,
          trialEndsAt: dateFor(trialEndsAt),
        }),
    );
  }

  async notifyDowngradeScheduled(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    effectiveAt: Date,
  ): Promise<void> {
    // Fix round (finding 3): key includes toPlanName — a CORRECTED downgrade to a different
    // target plan at the SAME effective date (e.g. SCALE→LITE re-scheduled to SCALE→STARTER
    // before the first one applies) must not be suppressed as "already sent".
    const key = `${toPlanName}@${effectiveAt.toISOString()}`;
    await this.sendIfClaimed(tenantId, "DOWNGRADE_SCHEDULED", key, (admin, businessName, dateFor) =>
      downgradeScheduledTemplate({
        businessName,
        adminName: admin.name,
        fromPlanName,
        toPlanName,
        effectiveAt: dateFor(effectiveAt),
      }),
    );
  }

  async notifyDowngradeApplied(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    effectiveAt: Date,
  ): Promise<void> {
    const key = `${toPlanName}@${effectiveAt.toISOString()}`;
    await this.sendIfClaimed(tenantId, "DOWNGRADE_APPLIED", key, (admin, businessName) =>
      downgradeAppliedTemplate({ businessName, adminName: admin.name, fromPlanName, toPlanName }),
    );
  }

  /**
   * `proratedAmount` must be the server's own proration preview/quote — never recompute it.
   * Fix round (finding 6): key = toPlanName + the subscription's CURRENT periodEnd, not
   * `new Date()` — a `new Date()` key never repeats so it could never dedupe a genuine
   * double-invocation within one billing period; periodEnd is stable for the period and moves
   * naturally once billing-cron's rollCycles advances it. `periodEnd` can be null for a
   * subscription with no period set yet (upgrade() does not require one) — falls back to a
   * day-granularity key in that case.
   */
  async notifyUpgradeConfirmed(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    proratedAmount: number,
    periodEnd: Date | null,
  ): Promise<void> {
    const key = `${toPlanName}@${periodEnd ? periodEnd.toISOString() : new Date().toISOString().slice(0, 10)}`;
    await this.sendIfClaimed(tenantId, "UPGRADE_CONFIRMED", key, (admin, businessName) =>
      upgradeConfirmedTemplate({
        businessName,
        adminName: admin.name,
        fromPlanName,
        toPlanName,
        proratedAmount,
      }),
    );
  }

  async notifyCancelled(tenantId: string): Promise<void> {
    const key = new Date().toISOString().slice(0, 10);
    await this.sendIfClaimed(tenantId, "CANCELLED", key, (admin, businessName) =>
      cancelledTemplate({ businessName, adminName: admin.name }),
    );
  }

  async notifySuspended(tenantId: string, reason: string): Promise<void> {
    const key = new Date().toISOString().slice(0, 10);
    await this.sendIfClaimed(tenantId, "SUSPENDED", key, (admin, businessName) =>
      suspendedTemplate({ businessName, adminName: admin.name, reason }),
    );
  }

  /**
   * SA-733r7 PR-B3: one dunning email to the tenant's admins, claimed per (tenant, milestone, invoiceId) so an
   * hourly sweep (or a redelivered webhook) sends each milestone once per invoice. `skipped` = already claimed;
   * a send nobody accepted releases the claim so the next sweep retries. Never throws.
   */
  async notifyDunning(
    tenantId: string,
    milestone: string,
    key: string,
    kind: DunningEmailKind,
    extra: {
      payUrl: string | null;
      readOnlyOn?: string;
      omitLockWarning?: boolean;
      byDate?: string;
      invoiceNumber?: string | null;
      amountCents?: number | null;
      currency?: string | null;
      attempted?: boolean;
      periodLabel?: string | null;
    },
  ): Promise<RfInvoiceSendResult> {
    return this.sendIfClaimed(tenantId, milestone, key, (admin, businessName) =>
      dunningTemplate({
        kind,
        businessName,
        adminName: admin.name,
        payUrl: extra.payUrl,
        readOnlyOn: extra.readOnlyOn,
        omitLockWarning: extra.omitLockWarning,
        byDate: extra.byDate,
        invoiceNumber: extra.invoiceNumber,
        amountCents: extra.amountCents,
        currency: extra.currency,
        attempted: extra.attempted,
        periodLabel: extra.periodLabel,
      }),
    );
  }

  /** The claim alone (no email): records that a milestone's notice went out inside another milestone's email. */
  recordDunningMilestone(tenantId: string, milestone: string, key: string): Promise<boolean> {
    return this.claim(tenantId, milestone, key);
  }

  /** The tenant-local date (and zone label) for a notice's calendar date. */
  async localDateLabel(tenantId: string, at: Date): Promise<string> {
    return this.formatDate(at, await this.tenantTimezone(tenantId));
  }

  /**
   * A paid Stripe checkout whose PLAN change was skipped because the tenant downgraded after the
   * session was created. Idempotent per checkout session (the key), never throws.
   */
  async notifyCheckoutPlanNotApplied(
    tenantId: string,
    requestedPlanKey: string,
    sessionId: string,
  ): Promise<void> {
    await this.sendIfClaimed(tenantId, "CHECKOUT_PLAN_SKIPPED", sessionId, (admin, businessName) =>
      checkoutPlanNotAppliedTemplate({ businessName, adminName: admin.name, requestedPlanKey }),
    );
  }
}
