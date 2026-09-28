import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { isInternalEmail } from "../../common/internal-email";
import { EmailService } from "../email.service";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";
import { mailboxRevokedCopy, mailboxThrottledCopy } from "./mailbox-alert.copy";
import { LeaderCron } from "../../common/cron-lock";
import { MAILBOX_ALERT_DELIVERY_DEADLINE_MS, MailboxAlertOutbox } from "./mailbox-alert-outbox";

/** What an alert says — rebuilt from the row at claim time, never from a stale emit. */
type AlertSubject = Pick<
  MailboxStateChange,
  "tenantId" | "provider" | "accountEmail" | "status" | "throttledUntil"
>;

/** How one attempt to settle an owed alert ended. */
export type AlertSettlement =
  | "delivered" // told the admins (or there were none), cleared
  | "stale" // the row no longer warrants it (reconnected, or the throttle has passed), cleared
  | "not-claimed" // another deliverer holds or cleared it, or it was re-pended since it was read
  | "abandoned"; // delivery failed or overran its deadline; the lease stays, the sweep retries

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
 *   - email: REVOKED only, through `EmailService.sendMailboxRevokedNotice`, which is always the
 *     PLATFORM sender class — never the dead mailbox, never the tenant's SMTP. A THROTTLED mailbox
 *     comes back by itself, so it does not warrant an email.
 *
 * Only TENANT_ADMINs are told: reconnecting is a TENANT_ADMIN-only action (`MailboxController`).
 *
 * #2113 (SA-528): the alert is DURABLE. The transition stamps `alertPendingAt` in its own
 * transaction; every delivery goes through `settle`, which claims it by CAS, delivers, and clears
 * it by CAS (`MailboxAlertOutbox`). The in-process listener settles it right after the commit;
 * `sweepPending` settles any the process died owing, or whose delivery was abandoned.
 * Everything runs inside the change's own tenant context, whatever context the detecting send ran
 * in. Never throws — a notification failure is logged and swallowed; it can never reach a send.
 */
@Injectable()
export class MailboxAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailboxAlertService.name);
  private unsubscribe: (() => void) | null = null;
  /** Overridable in specs to move the lease clock. */
  now: () => Date = () => new Date();
  private readonly outbox: MailboxAlertOutbox;

  constructor(
    private readonly mailboxSend: MailboxSendService,
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {
    this.outbox = new MailboxAlertOutbox(prisma, () => this.now());
  }

  onModuleInit(): void {
    this.unsubscribe = this.mailboxSend.onStateChange((change) => this.notifyAdmins(change));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The in-process path: settle the alert this change's transition committed. Never throws. */
  async notifyAdmins(change: MailboxStateChange): Promise<void> {
    await this.settle(change.connectionId, change.alertPendingAt);
  }

  /** Delivers every owed alert whose value is due (a fresh one, or an expired lease). */
  @LeaderCron("*/5 * * * *", "mailbox-alert.sweepPending")
  async sweepPending(): Promise<number> {
    let delivered = 0;
    for (const row of await this.outbox.due()) {
      if ((await this.settle(row.id, row.alertPendingAt)) === "delivered") delivered += 1;
    }
    return delivered;
  }

  /**
   * Claim the alert owed at `seen`, deliver it inside its tenant's context within the deadline,
   * then clear it. Never throws. Only a claim winner delivers; an abandoned delivery keeps its
   * lease, so the sweep retries it once the lease has passed.
   */
  async settle(connectionId: string, seen: Date | null | undefined): Promise<AlertSettlement> {
    let lease: Date | null = null;
    try {
      lease = await this.outbox.claim(connectionId, seen);
      if (!lease) return "not-claimed";
      const row = await this.prisma.mailboxConnection.findUnique({
        where: { id: connectionId },
        select: {
          tenantId: true,
          provider: true,
          accountEmail: true,
          status: true,
          throttledUntil: true,
        },
      });
      if (!row) return "not-claimed"; // disconnected meanwhile: nothing left to owe
      const { status } = row;
      const stale =
        (status !== "REVOKED" && status !== "THROTTLED") ||
        (status === "THROTTLED" && (!row.throttledUntil || row.throttledUntil <= this.now()));
      if (stale) {
        // Reconnected, or the throttle has already lifted: the alert no longer says anything true.
        await this.outbox.clear(connectionId, lease);
        return "stale";
      }
      const subject: AlertSubject = { ...row, status };
      const finished = await withDeadline(
        this.tenantCtx.run(row.tenantId, () => this.deliver(subject)),
        MAILBOX_ALERT_DELIVERY_DEADLINE_MS,
      );
      if (!finished) {
        // AT-LEAST-ONCE here (#2650 review): a timed-out `deliver` cannot be cancelled and may
        // still finish sending after this returns, and the sweep re-delivers once the lease has
        // passed — so a delivery slower than the deadline can reach an admin twice. Accepted:
        // a duplicate alert is far cheaper than a lost one (SA-528).
        this.logger.warn(
          `Mailbox ${row.status} alert for tenant ${row.tenantId} overran its deadline — left owed; the sweep retries after the lease.`,
        );
        return "abandoned";
      }
      // Cleared even if every per-admin push/email failed (#2650 review, deliberate): those
      // failures are per-recipient and often permanent — push opted out (B04), no deliverable
      // email — so re-owing them would retry forever every lease. Only a failure of the delivery
      // ITSELF (admin lookup, fallback check, deadline) leaves the alert owed. The audit row and
      // the mailbox's own status in Settings → Email remain the durable record either way.
      await this.outbox.clear(connectionId, lease);
      return "delivered";
    } catch (err) {
      this.logger.error(
        `Mailbox alert for connection ${connectionId} failed${lease ? " — left owed; the sweep retries after the lease" : ""}: ${
          err instanceof Error ? err.name : typeof err
        }`,
      );
      return lease ? "abandoned" : "not-claimed";
    }
  }

  private async deliver(change: AlertSubject): Promise<void> {
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
    change: AlertSubject,
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

/** True when `work` settled within `ms`; false on timeout. A rejection propagates. */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
