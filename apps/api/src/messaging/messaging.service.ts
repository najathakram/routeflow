import { Inject, Injectable, Logger } from "@nestjs/common";
import { MessageChannel, MeterKey, NotificationEvent, UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { MESSAGE_PROVIDER, type MessageProvider } from "./providers/message-provider.interface";
import { DEFAULT_TEMPLATES, EVENT_CHANNELS, seedDefaultsFor } from "./messaging-config.service";
import {
  isInvoicePolicyViolation,
  isMetered,
  isQuietHours,
  renderTemplate,
  requiresConsent,
} from "./messaging.helpers";

export type SkipReason =
  | "INVOICE_POLICY"
  | "NO_CONSENT"
  | "OPTED_OUT"
  | "NO_CONTACT"
  | "NO_CUSTOMER"
  | "SEND_FAILED"
  | "NO_TRANSPORT";

/**
 * N1: order-status events gated by the buyer's own `Customer.orderStatusEmails`
 * preference (opt-OUT, default true) — EMAIL only, and ONLY these four events.
 * Every other EMAIL-capable event (INVOICE_SENT, PAYMENT_REMINDER,
 * LICENSE_EXPIRING) and every non-order-status security mail sent directly via
 * EmailService (verification/password/invite — outside this engine entirely)
 * is NEVER opt-out.
 */
const ORDER_STATUS_EMAIL_EVENTS = new Set<NotificationEvent>([
  NotificationEvent.ORDER_CONFIRMED,
  NotificationEvent.OUT_FOR_DELIVERY,
  NotificationEvent.DELIVERED,
  NotificationEvent.CANCELLED,
]);

export interface SendOutcome {
  channel: MessageChannel;
  outcome: "sent" | "skipped" | "failed";
  reason?: SkipReason;
  /** True when the send fell inside quiet hours (recorded, not blocked in P6-2). */
  wouldBeQuiet?: boolean;
  providerMsgId?: string;
}

export interface SendMessageInput {
  customerId: string;
  channel: MessageChannel;
  body: string;
  /** Message.senderId — a real User id (the operator triggering the send). */
  senderId: string;
  senderRole?: string;
  eventKey?: NotificationEvent;
  templateName?: string;
  /** N1: email subject — see SendInput.subject. Ignored by non-EMAIL channels. */
  subject?: string;
}

/**
 * P6-2 messaging send engine. Provider-agnostic: it renders, gates
 * (invoice-policy → consent → opt-out → quiet-hours), dispatches via the
 * MESSAGE_PROVIDER (StubProvider by default), records a Message on the
 * customer's MessageThread, bumps the thread, and meters WhatsApp/SMS.
 * Real adapters, webhooks, triggers, inbox, and the quiet-hours queue are
 * later P6 increments — see the deferred list in the P6-2 plan.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meter: MeterService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
  ) {}

  /** Find-or-create the customer's single cross-channel thread. */
  async upsertThread(customerId: string) {
    const db = this.prisma.forTenant();
    const existing = await db.messageThread.findFirst({ where: { customerId } });
    if (existing) return existing;
    return db.messageThread.create({ data: { customerId, status: "OPEN" } });
  }

  private contactFor(
    channel: MessageChannel,
    customer: { phone: string | null; mobile: string | null; email: string | null },
  ): string {
    if (channel === MessageChannel.EMAIL) return customer.email ?? "";
    if (channel === MessageChannel.WHATSAPP || channel === MessageChannel.SMS) {
      return customer.phone ?? customer.mobile ?? "";
    }
    return ""; // INTERNAL / PORTAL: no external contact
  }

  private usesProvider(channel: MessageChannel): boolean {
    return channel !== MessageChannel.INTERNAL && channel !== MessageChannel.PORTAL;
  }

  async sendMessage(input: SendMessageInput): Promise<SendOutcome> {
    const { customerId, channel, body, senderId, eventKey } = input;
    const senderRole = input.senderRole ?? "OPERATOR";
    const skip = (reason: SkipReason): SendOutcome => ({ channel, outcome: "skipped", reason });

    // 1. G12 — invoices never go over WhatsApp/SMS.
    if (isInvoicePolicyViolation(eventKey, channel)) return skip("INVOICE_POLICY");

    const db = this.prisma.forTenant();
    const customer = await db.customer.findFirst({
      where: { id: customerId },
      select: {
        id: true,
        phone: true,
        mobile: true,
        email: true,
        smsConsent: true,
        waConsent: true,
        orderStatusEmails: true,
      },
    });
    if (!customer) return skip("NO_CUSTOMER");

    // 2. Consent (WhatsApp/SMS only).
    if (requiresConsent(channel)) {
      const consented =
        channel === MessageChannel.WHATSAPP ? customer.waConsent : customer.smsConsent;
      if (!consented) return skip("NO_CONSENT");
    }

    // 3. Opt-out (WhatsApp/SMS only — @@unique([tenantId, customerId, channel])).
    if (requiresConsent(channel)) {
      const optOut = await db.messageOptOut.findFirst({ where: { customerId, channel } });
      if (optOut) return skip("OPTED_OUT");
    }

    // 3b. N1 — buyer's own order-status EMAIL preference (opt-OUT, default true).
    // EMAIL + one of the four order-status events ONLY: never gates INVOICE_SENT/
    // PAYMENT_REMINDER/LICENSE_EXPIRING, and never gates security mail (that goes
    // through EmailService directly, outside this engine).
    if (
      channel === MessageChannel.EMAIL &&
      eventKey &&
      ORDER_STATUS_EMAIL_EVENTS.has(eventKey) &&
      !customer.orderStatusEmails
    ) {
      return skip("OPTED_OUT");
    }

    // Destination must exist for provider channels.
    const to = this.contactFor(channel, customer);
    if (this.usesProvider(channel) && !to) return skip("NO_CONTACT");

    // 4. Quiet hours — computed + recorded, NOT blocked/scheduled in P6-2.
    const tenantId = this.prisma.getTenantId();
    const settings = tenantId
      ? await db.messagingSettings.findUnique({ where: { tenantId } })
      : null;
    const wouldBeQuiet = settings
      ? isQuietHours(new Date(), {
          quietHoursEnabled: settings.quietHoursEnabled,
          quietHoursStart: settings.quietHoursStart,
          quietHoursEnd: settings.quietHoursEnd,
        })
      : false;

    // 4b. Transport capability (F23/B145, cause-ruling.md §2) — INTERNAL is
    //     always in-app (recorded, read by messages.service.ts) and is exempt;
    //     every other channel must have a bound provider that actually
    //     transports it, or a "sent" outcome would be fabricated. This is the
    //     ONE capability seam consulted by both send and config.
    if (channel !== MessageChannel.INTERNAL && !this.provider.transports(channel)) {
      return { channel, outcome: "skipped", reason: "NO_TRANSPORT", wouldBeQuiet };
    }

    // 5. Dispatch (provider channels only; INTERNAL/PORTAL record-only). A
    //    failed dispatch is NOT recorded and NOT metered — never bill for a
    //    message that didn't go out (matters once real adapters land in P6-3/4).
    let providerMsgId: string | undefined;
    if (this.usesProvider(channel)) {
      const res = await this.provider.send({
        tenantId,
        channel,
        to,
        body,
        templateName: input.templateName,
        subject: input.subject,
      });
      if (res.status === "failed") {
        return { channel, outcome: "failed", reason: "SEND_FAILED", wouldBeQuiet };
      }
      providerMsgId = res.providerMsgId;
    }

    // 6. Record the Message on the customer's thread.
    const thread = await this.upsertThread(customerId);
    await db.message.create({
      data: { threadId: thread.id, channel, text: body, senderId, senderRole, runId: null },
    });

    // 7. Bump the thread (preview / activity / unread).
    await db.messageThread.update({
      where: { id: thread.id },
      data: {
        lastChannel: channel,
        lastMessageAt: new Date(),
        lastMessagePreview: body.slice(0, 140),
        unreadCount: { increment: 1 },
      },
    });

    // 8. Meter WhatsApp/SMS (never throws; INTERNAL/EMAIL/PORTAL not metered).
    if (isMetered(channel) && tenantId) {
      await this.meter.increment(tenantId, MeterKey.MSGS, 1);
    }

    return { channel, outcome: "sent", providerMsgId, wouldBeQuiet };
  }

  /**
   * Fire a notification: for each ENABLED NotificationRule of `eventKey`, render
   * the channel's MessageTemplate and send. Opted-out / no-consent / invoice-
   * policy channels are skipped (the caller sees per-channel outcomes) and the
   * next enabled channel still runs — the fallback chain.
   */
  async notify(
    eventKey: NotificationEvent,
    args: { customerId: string; senderId: string; vars?: Record<string, string | number> },
  ): Promise<SendOutcome[]> {
    const db = this.prisma.forTenant();
    let rules = await db.notificationRule.findMany({ where: { eventKey, enabled: true } });
    if (rules.length === 0) {
      // F23/B182 (cause-ruling.md §2): a tenant that has never opened the notifications
      // settings tab (⇐ the only path that reached the old private seeder) has an EMPTY
      // notificationRule table, so notify() saw zero enabled rules forever even though
      // e.g. INVOICE_SENT:EMAIL is documented as on by default. Seed the shared defaults
      // here too (idempotent; createMany skipDuplicates) and re-read before giving up.
      const [allRules, allTemplates] = await Promise.all([
        db.notificationRule.findMany({}),
        db.messageTemplate.findMany({}),
      ]);
      const seeded = await seedDefaultsFor(db, allRules, allTemplates);
      if (seeded) {
        rules = await db.notificationRule.findMany({ where: { eventKey, enabled: true } });
      }
    }
    // N1 (Opus review): a persisted NotificationRule can predate this event's current
    // EVENT_CHANNELS membership — e.g. INVOICE_SENT:EMAIL was seeded ON for existing
    // tenants before EMAIL was removed from that event's channel list; without this
    // filter the stale row keeps firing forever (and once EmailChannelProvider made
    // EMAIL a real transport, would duplicate the PDF invoice email
    // invoices.service.ts already sends for real). Only channels EVENT_CHANNELS[eventKey]
    // currently allows are ever dispatched, regardless of what's persisted.
    rules = rules.filter((r) => EVENT_CHANNELS[eventKey].includes(r.channel));
    const outcomes: SendOutcome[] = [];
    for (const rule of rules) {
      const template = await db.messageTemplate.findFirst({
        where: { eventKey, channel: rule.channel, isActive: true },
      });
      if (!template) continue; // no active copy for this channel → skip
      const bodyText = renderTemplate(template.body, args.vars ?? {});
      outcomes.push(
        await this.sendMessage({
          customerId: args.customerId,
          channel: rule.channel,
          body: bodyText,
          senderId: args.senderId,
          senderRole: "SYSTEM",
          eventKey,
          templateName: template.waTemplateName ?? undefined,
          // N1: email subject — the same human label the settings matrix
          // already shows for this event (DEFAULT_TEMPLATES[eventKey].label).
          // Ignored by every non-EMAIL channel.
          subject: DEFAULT_TEMPLATES[eventKey].label,
        }),
      );
    }
    return outcomes;
  }

  /**
   * P6-5: resolve a User id usable as Message.senderId for system-originated
   * sends (crons / userless endpoints). Oldest ACTIVE TENANT_ADMIN, else oldest
   * ACTIVE OPERATOR (no Tenant.ownerId exists). Null → callers SKIP.
   */
  async resolveSystemSenderId(tenantId: string | null | undefined): Promise<string | null> {
    if (!tenantId) return null;
    const admin = await this.prisma.user.findFirst({
      where: { tenantId, role: UserRole.TENANT_ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (admin) return admin.id;
    const operator = await this.prisma.user.findFirst({
      where: { tenantId, role: UserRole.OPERATOR, status: UserStatus.ACTIVE, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return operator?.id ?? null;
  }

  /**
   * P6-5: trigger-facing convenience around notify(). NEVER rejects (fire-and-
   * forget AFTER a business write commits). senderId=null → resolve the system
   * sender; no sender → skip. Auto-fills customerName from Customer.businessName.
   */
  async notifyEvent(
    eventKey: NotificationEvent,
    args: { customerId: string; senderId: string | null; vars?: Record<string, string | number> },
  ): Promise<void> {
    try {
      const senderId =
        args.senderId ?? (await this.resolveSystemSenderId(this.prisma.getTenantId()));
      if (!senderId) {
        this.logger.warn(`notifyEvent(${eventKey}) skipped: no resolvable system sender`);
        return;
      }
      let vars = args.vars ?? {};
      if (vars.customerName === undefined) {
        const customer = await this.prisma.forTenant().customer.findFirst({
          where: { id: args.customerId },
          select: { businessName: true },
        });
        vars = { ...vars, customerName: customer?.businessName ?? "Customer" };
      }
      await this.notify(eventKey, { customerId: args.customerId, senderId, vars });
    } catch (err) {
      this.logger.warn(
        `notifyEvent(${eventKey}) failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─── Thin inbox reads (the rich inbox is a later increment) ──────────────────

  listThreads() {
    return this.prisma.forTenant().messageThread.findMany({
      orderBy: { lastMessageAt: "desc" },
    });
  }

  getThread(id: string) {
    return this.prisma.forTenant().messageThread.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  }
}
