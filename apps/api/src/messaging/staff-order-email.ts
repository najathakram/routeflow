import { Injectable, Logger } from "@nestjs/common";
import { NotificationEvent } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import type { EmailKind } from "../email/email-kinds";
import { escapeHtml } from "../common/html-escape";

/**
 * WS4 (SA-606) — staff emails for buyer-placed orders, buyer edits and buyer cancels.
 *
 * Rollout: the platform env ceiling `STAFF_ORDER_EMAIL=off|dark|on` (unset/garbage = "on") is
 * combined with a policy mode (fixed "dark" until the policy layer lands) and the EFFECTIVE mode
 * is the minimum of the two: off = nothing, dark = WOULD_SEND audit rows only, on = real sends.
 */
export type StaffOrderEmailMode = "off" | "dark" | "on";

const MODE_RANK: Record<StaffOrderEmailMode, number> = { off: 0, dark: 1, on: 2 };

function asMode(v: unknown): StaffOrderEmailMode | null {
  return v === "off" || v === "dark" || v === "on" ? v : null;
}

export function effectiveStaffOrderEmailMode(
  env: string | undefined,
  policy: StaffOrderEmailMode,
): StaffOrderEmailMode {
  const ceiling = asMode(env) ?? "on";
  const pol = asMode(policy) ?? "dark";
  return MODE_RANK[ceiling] <= MODE_RANK[pol] ? ceiling : pol;
}

/** The ONE predicate for "a buyer-initiated, non-draft order event should alert staff". */
export function shouldNotifyStaffOfOrder(input: {
  principal: "CUSTOMER" | "STAFF" | "DRIVER" | "CRON";
  isDraft: boolean;
}): boolean {
  return input.principal === "CUSTOMER" && !input.isDraft;
}

type StaffEvent = "STAFF_NEW_ORDER" | "BUYER_ORDER_EDITED" | "BUYER_ORDER_CANCELLED";

/** event -> the per-user preference key that can opt a recipient out (value "false"). */
const OPT_OUT_KEY: Record<StaffEvent, string> = {
  STAFF_NEW_ORDER: "staffOrderEmail",
  BUYER_ORDER_EDITED: "staffBuyerChangeEmail",
  BUYER_ORDER_CANCELLED: "staffBuyerChangeEmail",
};

const STAFF_CC_KEY = "notifications.staffCc";
const STAFF_CC_MAX = 5;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Recipient {
  email: string;
  userId?: string;
}

@Injectable()
export class StaffOrderEmailService {
  private readonly logger = new Logger(StaffOrderEmailService.name);

  /** Policy ceiling; "dark" until the policy layer flips it (specs override this field). */
  policyMode: StaffOrderEmailMode = "dark";

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly deliveries: EmailDeliveryService,
  ) {}

  /** Active tenant admins + up to 5 valid `notifications.staffCc` addresses, deduped. */
  async resolveRecipients(_tenantId: string): Promise<string[]> {
    return (await this.resolveRecipientRows()).map((r) => r.email);
  }

  private async resolveRecipientRows(): Promise<Recipient[]> {
    const db = this.prisma.forTenant();
    const out: Recipient[] = [];
    const seen = new Set<string>();
    const add = (raw: unknown, userId?: string) => {
      if (typeof raw !== "string") return;
      const email = raw.trim();
      const key = email.toLowerCase();
      if (!EMAIL_SHAPE.test(email) || seen.has(key)) return;
      seen.add(key);
      out.push({ email, userId });
    };

    const admins = await db.user.findMany({
      where: { role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      select: { id: true, email: true, role: true },
    });
    for (const u of admins) {
      // belt and braces on top of the where: never an OPERATOR / SUPER_ADMIN address
      if (u.role === "TENANT_ADMIN") add(u.email, u.id);
    }

    try {
      const cfg = await db.systemConfig.findFirst({ where: { key: STAFF_CC_KEY } });
      const parsed: unknown = cfg?.value ? JSON.parse(cfg.value) : [];
      if (Array.isArray(parsed)) {
        let added = 0;
        for (const raw of parsed) {
          if (added >= STAFF_CC_MAX) break;
          const before = out.length;
          add(raw);
          if (out.length > before) added++;
        }
      }
    } catch {
      // malformed / unreadable cc config: admins still get the mail
    }
    return out;
  }

  /** Fire-and-forget safe: NEVER rejects. */
  async notifyStaffEvent(event: NotificationEvent, ctx: { orderId: string }): Promise<void> {
    try {
      if (!(event in OPT_OUT_KEY)) return;
      const kind = event as StaffEvent;
      const mode = effectiveStaffOrderEmailMode(process.env.STAFF_ORDER_EMAIL, this.policyMode);
      if (mode === "off") return;

      const order = (await this.prisma.forTenant().order.findFirst({
        where: { id: ctx.orderId },
        include: { customer: true },
      })) as Record<string, any> | null;
      if (!order) return;
      const tenantId = String(order.tenantId);

      const recipients = await this.resolveRecipientRows();
      if (recipients.length === 0) return;
      const optedOut = await this.optedOutUserIds(recipients, OPT_OUT_KEY[kind]);

      const delivery = {
        tenantId,
        kind: kind as EmailKind,
        entityType: "Order",
        entityId: ctx.orderId,
      };
      const content = mode === "on" ? this.render(kind, order) : null;

      for (const r of recipients) {
        try {
          if (r.userId && optedOut.has(r.userId)) {
            await this.deliveries.record({ ...delivery, toAddress: r.email, status: "OPTED_OUT" });
          } else if (!content) {
            await this.deliveries.record({ ...delivery, toAddress: r.email, status: "WOULD_SEND" });
          } else {
            await this.email.send({ to: r.email, ...content, delivery });
          }
        } catch (err) {
          this.logger.warn(`Staff order email step failed: ${(err as Error)?.message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`notifyStaffEvent(${String(event)}) skipped: ${(err as Error)?.message}`);
    }
  }

  private async optedOutUserIds(recipients: Recipient[], key: string): Promise<Set<string>> {
    const ids = recipients.map((r) => r.userId).filter((v): v is string => !!v);
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const prefs = await this.prisma.forTenant().userPreference.findMany({
      where: { userId: { in: ids }, key },
    });
    for (const p of prefs as { userId: string; key: string; value: string }[]) {
      if (p.key === key && p.value === "false" && ids.includes(p.userId)) out.add(p.userId);
    }
    return out;
  }

  private render(kind: StaffEvent, order: Record<string, any>): { subject: string; html: string } {
    const number = String(order.orderNumber ?? order.id);
    const customer = String(order.customer?.businessName ?? order.customer?.name ?? "A customer");
    // The STORED total, never recomputed from line items (money discipline).
    const total = roundMoney(Number(order.total)).toFixed(2);
    const urgent = order.urgent === true || order.isUrgent === true;
    const headline =
      kind === "STAFF_NEW_ORDER"
        ? `New order ${number}`
        : kind === "BUYER_ORDER_EDITED"
          ? `Order ${number} was edited by the customer`
          : `Order ${number} was cancelled by the customer`;
    const subject = `${urgent ? "[URGENT] " : ""}${headline} - ${customer}`;
    const html =
      `<p>${escapeHtml(headline)}.</p>` +
      `<p>Customer: ${escapeHtml(customer)}<br>Order: ${escapeHtml(number)}<br>` +
      `Total: $${escapeHtml(total)}</p>`;
    return { subject, html };
  }
}
