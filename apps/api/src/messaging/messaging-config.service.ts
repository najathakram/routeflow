import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MessageChannel, MeterKey, NotificationEvent, WaApprovalStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { extractVariables, isInvoicePolicyViolation, renderTemplate } from "./messaging.helpers";

const { INTERNAL, WHATSAPP, SMS, EMAIL, PORTAL } = MessageChannel;
const CUSTOMER_CHANNELS: MessageChannel[] = [WHATSAPP, SMS, EMAIL, PORTAL];

/** Channels each event supports — single source of truth for the matrix (P6-6)
 *  AND P6-5's triggers. INVOICE_SENT omits WA/SMS (G12); ops alerts are INTERNAL-only. */
export const EVENT_CHANNELS: Record<NotificationEvent, MessageChannel[]> = {
  [NotificationEvent.ORDER_CONFIRMED]: CUSTOMER_CHANNELS,
  [NotificationEvent.OUT_FOR_DELIVERY]: CUSTOMER_CHANNELS,
  [NotificationEvent.DELIVERED]: CUSTOMER_CHANNELS,
  [NotificationEvent.ORDER_CHANGED_AT_DOOR]: CUSTOMER_CHANNELS,
  [NotificationEvent.INVOICE_SENT]: [EMAIL, PORTAL],
  [NotificationEvent.PAYMENT_REMINDER]: CUSTOMER_CHANNELS,
  [NotificationEvent.LICENSE_EXPIRING]: CUSTOMER_CHANNELS,
  [NotificationEvent.URGENT_ORDER_PLACED]: [INTERNAL],
  [NotificationEvent.LOW_STOCK]: [INTERNAL],
  [NotificationEvent.FAILED_DELIVERY]: [INTERNAL],
  [NotificationEvent.PAYMENT_FAILED_NSF]: [INTERNAL],
};

/** Friendly label + starter body per event; `variables` derived from the body
 *  via extractVariables at seed time. Money-looking vars are PRE-FORMATTED
 *  STRINGS supplied by P6-5 callers — no money math in messaging. */
export const DEFAULT_TEMPLATES: Record<NotificationEvent, { label: string; body: string }> = {
  [NotificationEvent.ORDER_CONFIRMED]: {
    label: "Order confirmed",
    body: "Hi {{customerName}}, your order {{orderNumber}} is confirmed for delivery on {{deliveryDate}}. Total: {{orderTotal}}.",
  },
  [NotificationEvent.OUT_FOR_DELIVERY]: {
    label: "Out for delivery",
    body: "Hi {{customerName}}, your order {{orderNumber}} is out for delivery today with {{driverName}}.",
  },
  [NotificationEvent.DELIVERED]: {
    label: "Delivered",
    body: "Hi {{customerName}}, order {{orderNumber}} was delivered. Total: {{orderTotal}}. Thank you!",
  },
  [NotificationEvent.ORDER_CHANGED_AT_DOOR]: {
    label: "Order changed at door",
    body: "Hi {{customerName}}, order {{orderNumber}} was adjusted at delivery: {{changeSummary}}. New total: {{orderTotal}}.",
  },
  [NotificationEvent.INVOICE_SENT]: {
    label: "Invoice sent",
    body: "Hi {{customerName}}, invoice {{invoiceNumber}} for {{invoiceTotal}} is ready. Due {{dueDate}}.",
  },
  [NotificationEvent.PAYMENT_REMINDER]: {
    label: "Payment reminder",
    body: "Hi {{customerName}}, a friendly reminder that invoice {{invoiceNumber}} ({{amountDue}}) is due {{dueDate}}.",
  },
  [NotificationEvent.LICENSE_EXPIRING]: {
    label: "License expiring",
    body: "Hi {{customerName}}, our records show your license expires on {{expiryDate}}. Please send us an updated copy.",
  },
  [NotificationEvent.URGENT_ORDER_PLACED]: {
    label: "Urgent order placed",
    body: "Urgent order {{orderNumber}} from {{customerName}} needs review.",
  },
  [NotificationEvent.LOW_STOCK]: {
    label: "Low stock",
    body: "Low stock: {{productName}} is down to {{quantity}} left.",
  },
  [NotificationEvent.FAILED_DELIVERY]: {
    label: "Failed delivery",
    body: "Delivery failed for order {{orderNumber}} ({{customerName}}): {{reason}}.",
  },
  [NotificationEvent.PAYMENT_FAILED_NSF]: {
    label: "Payment failed (NSF)",
    body: "Check payment from {{customerName}} for {{amount}} was returned NSF on invoice {{invoiceNumber}}.",
  },
};

/** Cells seeded enabled=true — PORTAL/EMAIL (free, un-metered, consent-less) +
 *  the internal alerts. Every metered/consented channel (WA/SMS) seeds OFF. */
export const DEFAULT_ON = new Set<string>([
  `${NotificationEvent.OUT_FOR_DELIVERY}:${PORTAL}`,
  `${NotificationEvent.DELIVERED}:${PORTAL}`,
  `${NotificationEvent.INVOICE_SENT}:${EMAIL}`,
  `${NotificationEvent.URGENT_ORDER_PLACED}:${INTERNAL}`,
  `${NotificationEvent.LOW_STOCK}:${INTERNAL}`,
  `${NotificationEvent.FAILED_DELIVERY}:${INTERNAL}`,
  `${NotificationEvent.PAYMENT_FAILED_NSF}:${INTERNAL}`,
]);

export interface TemplateView {
  id: string;
  body: string;
  variables: string[];
  waTemplateName: string | null;
  waApprovalStatus: WaApprovalStatus;
  isActive: boolean;
}
export interface MatrixCell {
  channel: MessageChannel;
  enabled: boolean;
  ruleId: string | null;
  locked: boolean;
  template: TemplateView | null;
}
export interface MatrixEvent {
  eventKey: NotificationEvent;
  label: string;
  channels: MatrixCell[];
}
export interface MessagingSettingsView {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string | null;
}
export interface MessagingConfigView {
  events: MatrixEvent[];
  settings: MessagingSettingsView;
  msgsMeter: {
    used: number;
    included: number | null;
    remaining: number | null;
    resetsAt: string | null;
  } | null;
}

@Injectable()
export class MessagingConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meter: MeterService,
  ) {}

  async getMatrix(): Promise<MessagingConfigView> {
    const tenantId = this.requireTenant();
    const db = this.prisma.forTenant();
    let [rules, templates] = await Promise.all([
      db.notificationRule.findMany({}),
      db.messageTemplate.findMany({}),
    ]);
    const seeded = await this.seedMissing(db, rules, templates);
    if (seeded)
      [rules, templates] = await Promise.all([
        db.notificationRule.findMany({}),
        db.messageTemplate.findMany({}),
      ]);

    const ruleBy = new Map(rules.map((r) => [`${r.eventKey}:${r.channel}`, r]));
    const tplBy = new Map(templates.map((t) => [`${t.eventKey}:${t.channel}`, t]));

    const events: MatrixEvent[] = (Object.keys(EVENT_CHANNELS) as NotificationEvent[]).map(
      (eventKey) => {
        const channels: MatrixCell[] = EVENT_CHANNELS[eventKey].map((channel) => {
          const rule = ruleBy.get(`${eventKey}:${channel}`);
          const tpl = tplBy.get(`${eventKey}:${channel}`);
          return {
            channel,
            enabled: rule?.enabled ?? false,
            ruleId: rule?.id ?? null,
            locked: false,
            template: tpl ? this.templateView(tpl) : null,
          };
        });
        for (const channel of [WHATSAPP, SMS]) {
          if (isInvoicePolicyViolation(eventKey, channel))
            channels.push({ channel, enabled: false, ruleId: null, locked: true, template: null });
        }
        return { eventKey, label: DEFAULT_TEMPLATES[eventKey].label, channels };
      },
    );

    const settings = await this.getSettings();
    let msgsMeter: MessagingConfigView["msgsMeter"] = null;
    try {
      const r = await this.meter.read(tenantId, MeterKey.MSGS);
      msgsMeter = {
        used: r.used,
        included: r.included,
        remaining: r.remaining,
        resetsAt: r.resetsAt ? r.resetsAt.toISOString() : null,
      };
    } catch {
      /* meter readout is decorative — never fail the matrix for it */
    }
    return { events, settings, msgsMeter };
  }

  async setRuleEnabled(id: string, enabled: boolean) {
    const db = this.prisma.forTenant();
    const rule = await db.notificationRule.findFirst({ where: { id } });
    if (!rule) throw new NotFoundException("Notification rule not found");
    if (enabled && isInvoicePolicyViolation(rule.eventKey, rule.channel))
      throw new BadRequestException("Invoices cannot be sent over WhatsApp/SMS");
    const updated = await db.notificationRule.update({ where: { id }, data: { enabled } });
    return {
      id: updated.id,
      eventKey: updated.eventKey,
      channel: updated.channel,
      enabled: updated.enabled,
    };
  }

  async updateTemplate(
    id: string,
    dto: { body?: string; waTemplateName?: string; isActive?: boolean },
  ): Promise<TemplateView> {
    const db = this.prisma.forTenant();
    const existing = await db.messageTemplate.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException("Message template not found");
    const data: Record<string, unknown> = {};
    if (dto.body !== undefined) {
      data.body = dto.body;
      data.variables = extractVariables(dto.body);
    }
    if (dto.waTemplateName !== undefined)
      data.waTemplateName = dto.waTemplateName === "" ? null : dto.waTemplateName;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const updated = await db.messageTemplate.update({ where: { id }, data });
    return this.templateView(updated);
  }

  preview(body: string, vars: Record<string, string | number> = {}) {
    return { rendered: renderTemplate(body, vars), variables: extractVariables(body) };
  }

  async getSettings(): Promise<MessagingSettingsView> {
    const tenantId = this.requireTenant();
    const row = await this.prisma.forTenant().messagingSettings.findUnique({ where: { tenantId } });
    return {
      quietHoursEnabled: row?.quietHoursEnabled ?? true,
      quietHoursStart: row?.quietHoursStart ?? "21:00",
      quietHoursEnd: row?.quietHoursEnd ?? "07:00",
      timezone: row?.timezone ?? null,
    };
  }

  async updateSettings(dto: {
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    timezone?: string;
  }): Promise<MessagingSettingsView> {
    const tenantId = this.requireTenant();
    const data: Record<string, unknown> = {};
    if (dto.quietHoursEnabled !== undefined) data.quietHoursEnabled = dto.quietHoursEnabled;
    if (dto.quietHoursStart !== undefined) data.quietHoursStart = dto.quietHoursStart;
    if (dto.quietHoursEnd !== undefined) data.quietHoursEnd = dto.quietHoursEnd;
    if (dto.timezone !== undefined) data.timezone = dto.timezone === "" ? null : dto.timezone;
    await this.prisma.forTenant().messagingSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    return this.getSettings();
  }

  private async seedMissing(
    db: PrismaService,
    rules: Array<{ eventKey: NotificationEvent; channel: MessageChannel }>,
    templates: Array<{ eventKey: NotificationEvent; channel: MessageChannel }>,
  ): Promise<boolean> {
    const haveRule = new Set(rules.map((r) => `${r.eventKey}:${r.channel}`));
    const haveTpl = new Set(templates.map((t) => `${t.eventKey}:${t.channel}`));
    const ruleData: Array<{
      eventKey: NotificationEvent;
      channel: MessageChannel;
      enabled: boolean;
    }> = [];
    const tplData: Array<{
      eventKey: NotificationEvent;
      channel: MessageChannel;
      body: string;
      variables: string[];
      isActive: boolean;
    }> = [];
    for (const eventKey of Object.keys(EVENT_CHANNELS) as NotificationEvent[]) {
      for (const channel of EVENT_CHANNELS[eventKey]) {
        const key = `${eventKey}:${channel}`;
        if (!haveRule.has(key)) ruleData.push({ eventKey, channel, enabled: DEFAULT_ON.has(key) });
        if (!haveTpl.has(key))
          tplData.push({
            eventKey,
            channel,
            body: DEFAULT_TEMPLATES[eventKey].body,
            variables: extractVariables(DEFAULT_TEMPLATES[eventKey].body),
            isActive: true,
          });
      }
    }
    if (ruleData.length === 0 && tplData.length === 0) return false;
    if (ruleData.length > 0)
      await db.notificationRule.createMany({ data: ruleData, skipDuplicates: true });
    if (tplData.length > 0)
      await db.messageTemplate.createMany({ data: tplData, skipDuplicates: true });
    return true;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Tenant context required");
    return tenantId;
  }

  private templateView(t: {
    id: string;
    body: string;
    variables: string[];
    waTemplateName: string | null;
    waApprovalStatus: WaApprovalStatus;
    isActive: boolean;
  }): TemplateView {
    return {
      id: t.id,
      body: t.body,
      variables: t.variables,
      waTemplateName: t.waTemplateName,
      waApprovalStatus: t.waApprovalStatus,
      isActive: t.isActive,
    };
  }
}
