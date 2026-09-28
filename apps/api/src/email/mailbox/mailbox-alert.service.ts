import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { isInternalEmail } from "../../common/internal-email";
import { EmailService } from "../email.service";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";
import { mailboxRevokedCopy, mailboxThrottledCopy } from "./mailbox-alert.copy";

interface AdminRecipient {
  id: string;
  email: string;
  username: string;
}

/**
 * F-10a (#2077) — tells a tenant's admins, once per state change, that their connected mailbox
 * stopped sending on its own. `MailboxSendService` makes the transition (one conditional update)
 * and writes the audit row; this service only notifies, through the paths the app already uses to
 * reach a tenant's staff (`AuthorizationExpiryService.notify` is the model):
 *
 *   - in-app: `NotificationsService.sendToUser`, to every ACTIVE TENANT_ADMIN — REVOKED and
 *     THROTTLED. A user's own push opt-out (B04) is honoured there.
 *   - web bell (#2113): one `mailbox.alert` socket emit to the tenant's TENANT_ADMIN room, with
 *     the same copy — status, provider, title and body only.
 *   - email: REVOKED only, through `EmailService.sendMailboxRevokedNotice`, which is always the
 *     PLATFORM sender class — never the dead mailbox, never the tenant's SMTP. A THROTTLED mailbox
 *     comes back by itself, so it does not warrant an email.
 *
 * Only TENANT_ADMINs are told: reconnecting is a TENANT_ADMIN-only action (`MailboxController`).
 * Everything runs inside the change's own tenant context, whatever context the detecting send ran
 * in. Never throws — a notification failure is logged and swallowed; it can never reach a send.
 */
@Injectable()
export class MailboxAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailboxAlertService.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly mailboxSend: MailboxSendService,
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    // #2113: the web bell. Optional so a context without the gateway still notifies by push/email.
    @Optional() private readonly gateway?: RouteFlowGateway,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.mailboxSend.onStateChange((change) => this.notifyAdmins(change));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async notifyAdmins(change: MailboxStateChange): Promise<void> {
    try {
      await this.tenantCtx.run(change.tenantId, () => this.deliver(change));
    } catch (err) {
      this.logger.error(
        `Mailbox ${change.status} notification failed for tenant ${change.tenantId}: ${
          err instanceof Error ? err.name : typeof err
        }`,
      );
    }
  }

  private async deliver(change: MailboxStateChange): Promise<void> {
    const admins = await this.adminsOf(change.tenantId);
    if (admins.length === 0) {
      this.logger.warn(
        `Mailbox ${change.status} for tenant ${change.tenantId}: no active tenant admin to notify.`,
      );
      return;
    }
    const hasFallback = await this.email.isEmailConfigured();

    if (change.status === "THROTTLED") {
      const { inApp } = mailboxThrottledCopy({
        accountEmail: change.accountEmail,
        provider: change.provider,
        throttledUntil: change.throttledUntil,
        hasFallback,
        now: new Date(),
      });
      await this.sendInApp(change, admins, inApp);
      return;
    }

    const { inApp } = mailboxRevokedCopy({
      accountEmail: change.accountEmail,
      provider: change.provider,
      hasFallback,
    });
    await this.sendInApp(change, admins, inApp);

    // One email per mailbox: two admin rows can share an address (in different casing).
    const emailed = new Set<string>();
    for (const admin of admins) {
      const to = admin.email.trim();
      if (!to || isInternalEmail(to) || emailed.has(to.toLowerCase())) continue;
      emailed.add(to.toLowerCase());
      try {
        const result = await this.email.sendMailboxRevokedNotice({
          to,
          username: admin.username,
          accountEmail: change.accountEmail,
          provider: change.provider,
          hasFallback,
        });
        if (!result.delivered) {
          this.logger.warn(
            `Mailbox REVOKED email not delivered to admin ${admin.id} of tenant ${change.tenantId} (${result.transport}).`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Mailbox REVOKED email failed for admin ${admin.id} of tenant ${change.tenantId}: ${
            err instanceof Error ? err.name : typeof err
          }`,
        );
      }
    }
  }

  private async sendInApp(
    change: MailboxStateChange,
    admins: AdminRecipient[],
    inApp: { title: string; body: string },
  ): Promise<void> {
    const event =
      change.status === "REVOKED" ? "mailbox.revoked_detected" : "mailbox.throttled_detected";
    for (const admin of admins) {
      try {
        await this.notifications.sendToUser(admin.id, {
          title: inApp.title,
          body: inApp.body,
          data: { event },
        });
      } catch (err) {
        this.logger.warn(
          `Mailbox ${change.status} in-app notification failed for admin ${admin.id} of tenant ${change.tenantId}: ${
            err instanceof Error ? err.name : typeof err
          }`,
        );
      }
    }
    // #2113: web-only admins get no push; the bell reaches every open admin tab once.
    try {
      this.gateway?.emitMailboxAlert(change.tenantId, {
        status: change.status,
        provider: change.provider,
        title: inApp.title,
        body: inApp.body,
      });
    } catch (err) {
      this.logger.warn(
        `Mailbox ${change.status} web alert failed for tenant ${change.tenantId}: ${
          err instanceof Error ? err.name : typeof err
        }`,
      );
    }
  }

  /** Every ACTIVE, non-deleted TENANT_ADMIN of the tenant — the same predicate as the billing
   *  and low-stock notices (`BillingNotificationService.adminsOf`). */
  private async adminsOf(tenantId: string): Promise<AdminRecipient[]> {
    return this.prisma.user.findMany({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      select: { id: true, email: true, username: true },
      orderBy: { createdAt: "asc" },
    });
  }
}
