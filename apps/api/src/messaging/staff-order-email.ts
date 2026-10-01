import { Injectable, Logger } from "@nestjs/common";
import { NotificationEvent } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import type { EmailKind } from "../email/email-kinds";
import { escapeHtml } from "../common/html-escape";
import { isInternalEmail } from "../common/internal-email";

/**
 * WS4 (SA-606) — staff emails for buyer-placed orders, buyer edits and buyer cancels.
 *
 * Rollout: the platform env ceiling `STAFF_ORDER_EMAIL=off|dark|on` (only the literal off|dark|on are honoured; unset/garbage = "dark") is
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
  const ceiling = asMode(env) ?? "dark";
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

  /** Read-only effective mode (env ceiling read at call time, min with the policy term). */
  getEffectiveMode(): StaffOrderEmailMode {
    return effectiveStaffOrderEmailMode(process.env.STAFF_ORDER_EMAIL, this.policyMode);
  }

  /** Active tenant admins + up to 5 valid `notifications.staffCc` addresses, deduped. */
  async resolveRecipients(tenantId: string): Promise<string[]> {
    return (await this.resolveRecipientRows(tenantId)).map((r) => r.email);
  }

  /**
   * `forTenant()` returns the UNSCOPED client when there is no tenant context (job worker,
   * SUPER_ADMIN), so every query here names the tenant explicitly.
   */
  private async resolveRecipientRows(tenantId: string): Promise<Recipient[]> {
    const db = this.prisma.forTenant();
    const out: Recipient[] = [];
    const seen = new Set<string>();
    const add = (raw: unknown, userId?: string) => {
      if (typeof raw !== "string") return;
      const email = raw.trim();
      const key = email.toLowerCase();
      if (!EMAIL_SHAPE.test(email) || isInternalEmail(email) || seen.has(key)) return;
      seen.add(key);
      out.push({ email, userId });
    };

    const admins = await db.user.findMany({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      select: { id: true, email: true, role: true },
    });
    for (const u of admins) {
      // belt and braces on top of the where: never an OPERATOR / SUPER_ADMIN address
      if (u.role === "TENANT_ADMIN") add(u.email, u.id);
    }

    try {
      const cfg = await db.systemConfig.findFirst({ where: { tenantId, key: STAFF_CC_KEY } });
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

  /**
   * Fire-and-forget safe: NEVER rejects.
   *
   * NOTE for whoever wires this from a job/outbox worker: there is no ambient tenant there, and this
   * method REFUSES without one (it must equal `order.tenantId`). Wrap the call in the tenant context
   * runner — `ctx.run(order.tenantId, () => notifyStaffEvent(...))` — never call it bare from a job.
   */
  async notifyStaffEvent(event: NotificationEvent, ctx: { orderId: string }): Promise<void> {
    try {
      if (!(event in OPT_OUT_KEY)) return;
      const kind = event as StaffEvent;
      const mode = this.getEffectiveMode();
      if (mode === "off") return;

      const order = (await this.prisma.forTenant().order.findFirst({
        where: { id: ctx.orderId },
        include: { customer: true },
      })) as Record<string, any> | null;
      if (!order) return;
      const tenantId = String(order.tenantId);

      // Refuse without a matching ambient tenant: the unscoped client would otherwise expose
      // every tenant's admins and staffCc (#2872 review B1).
      const ambient = this.prisma.getTenantId();
      if (!ambient || ambient !== tenantId) {
        this.logger.warn(
          `notifyStaffEvent(${String(event)}) refused: ambient tenant missing or differs from the order's`,
        );
        return;
      }

      const recipients = await this.resolveRecipientRows(tenantId);
      if (recipients.length === 0) return;
      const optedOut = await this.optedOutUserIds(recipients, OPT_OUT_KEY[kind], tenantId);

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

  private async optedOutUserIds(
    recipients: Recipient[],
    key: string,
    tenantId: string,
  ): Promise<Set<string>> {
    const ids = recipients.map((r) => r.userId).filter((v): v is string => !!v);
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const prefs = await this.prisma.forTenant().userPreference.findMany({
      where: { tenantId, userId: { in: ids }, key },
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
