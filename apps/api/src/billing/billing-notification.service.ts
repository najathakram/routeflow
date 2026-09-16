import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import {
  trialEndingTemplate,
  downgradeScheduledTemplate,
  downgradeAppliedTemplate,
  upgradeConfirmedTemplate,
  cancelledTemplate,
  suspendedTemplate,
  TrialEndingMilestone,
  BillingEmailTemplate,
} from "./billing-notification.templates";

// N3 (2026-09-16): sends billing-lifecycle emails to the tenant admin, fail-closed and
// idempotent per (tenant, milestone[, key]) via BillingNotificationLog's unique constraint.
// Every public method here NEVER throws — a notification failure (claim error, missing
// admin, send failure) is logged and swallowed so the caller's business action (plan
// change, cancellation, suspension) always succeeds regardless of email outcome.

const isUniqueViolation = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";

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

  private async adminOf(tenantId: string): Promise<{ email: string; name: string } | null> {
    const admin = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", deletedAt: null },
      select: { email: true, username: true },
    });
    if (!admin?.email) return null;
    return { email: admin.email, name: admin.username ?? admin.email };
  }

  private async businessNameOf(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    return tenant?.name ?? tenant?.slug ?? "your account";
  }

  private async sendIfClaimed(
    tenantId: string,
    milestone: string,
    key: string,
    build: (admin: { email: string; name: string }, businessName: string) => BillingEmailTemplate,
  ): Promise<void> {
    try {
      const won = await this.claim(tenantId, milestone, key);
      if (!won) return;
      const admin = await this.adminOf(tenantId);
      if (!admin) return; // no tenant admin to notify — fail closed, nothing to send to
      const businessName = await this.businessNameOf(tenantId);
      const tmpl = build(admin, businessName);
      await this.email.send({
        to: admin.email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
    } catch (e) {
      this.logger.error(`billing-notification failed for ${tenantId}/${milestone}`, e as Error);
    }
  }

  async notifyTrialEnding(
    tenantId: string,
    milestone: TrialEndingMilestone,
    trialEndsAt: Date,
  ): Promise<void> {
    await this.sendIfClaimed(tenantId, milestone, "", (admin, businessName) =>
      trialEndingTemplate({
        businessName,
        adminName: admin.name,
        milestone,
        trialEndsAt: trialEndsAt.toISOString().slice(0, 10),
      }),
    );
  }

  async notifyDowngradeScheduled(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    effectiveAt: Date,
  ): Promise<void> {
    await this.sendIfClaimed(
      tenantId,
      "DOWNGRADE_SCHEDULED",
      effectiveAt.toISOString(),
      (admin, businessName) =>
        downgradeScheduledTemplate({
          businessName,
          adminName: admin.name,
          fromPlanName,
          toPlanName,
          effectiveAt: effectiveAt.toISOString().slice(0, 10),
        }),
    );
  }

  async notifyDowngradeApplied(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    effectiveAt: Date,
  ): Promise<void> {
    await this.sendIfClaimed(
      tenantId,
      "DOWNGRADE_APPLIED",
      effectiveAt.toISOString(),
      (admin, businessName) =>
        downgradeAppliedTemplate({ businessName, adminName: admin.name, fromPlanName, toPlanName }),
    );
  }

  /** `proratedAmount` must be the server's own proration preview/quote — never recompute it. */
  async notifyUpgradeConfirmed(
    tenantId: string,
    fromPlanName: string,
    toPlanName: string,
    proratedAmount: number,
  ): Promise<void> {
    const key = `${toPlanName}@${new Date().toISOString()}`;
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
}
