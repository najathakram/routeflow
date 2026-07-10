import { Inject, Injectable, Logger } from "@nestjs/common";
import { MessageChannel, MeterKey, NotificationEvent } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { MESSAGE_PROVIDER, type MessageProvider } from "./providers/message-provider.interface";
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
  | "SEND_FAILED";

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
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        phone: true,
        mobile: true,
        email: true,
        smsConsent: true,
        waConsent: true,
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
    const rules = await db.notificationRule.findMany({ where: { eventKey, enabled: true } });
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
        }),
      );
    }
    return outcomes;
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
