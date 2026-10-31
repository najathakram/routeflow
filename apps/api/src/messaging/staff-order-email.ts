import { Injectable, Logger } from "@nestjs/common";
import { NotificationEvent } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import type { EmailKind } from "../email/email-kinds";
import { escapeHtml } from "../common/html-escape";
import { isInternalEmail } from "../common/internal-email";
import { PolicyService } from "../policy/policy.service";
import type { StaffOrderEmailPolicyMode } from "../policy/policy-registry";

/**
 * WS4 (SA-606) — staff emails for buyer-placed orders, buyer edits and buyer cancels.
 *
 * Rollout: the platform env ceiling `STAFF_ORDER_EMAIL=off|dark|on` (only the literal off|dark|on are honoured; unset/garbage = "dark") is
 * combined with the tenant policy `notifications.staffOrderEmail` (SA-1063) and the EFFECTIVE mode
 * is the minimum of the two: off = nothing, dark = WOULD_SEND audit rows only, on = real sends.
 */
export type StaffOrderEmailMode = StaffOrderEmailPolicyMode;

const MODE_RANK: Record<StaffOrderEmailMode, number> = { off: 0, dark: 1, on: 2 };

function asMode(v: unknown): StaffOrderEmailMode | null {
  return v === "off" || v === "dark" || v === "on" ? v : null;
}

/** A stored policy value narrowed to a mode; anything else reads as the default, "dark". */
export function toStaffOrderEmailMode(v: unknown): StaffOrderEmailMode {
  return asMode(v) ?? "dark";
}

export function effectiveStaffOrderEmailMode(
  env: string | undefined,
  policy: unknown,
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

/** SA-1063 MUST 9: a buyer may save an order many times; one edit email per order inside this window. */
export const BUYER_EDIT_EMAIL_WINDOW_MS = 10 * 60 * 1000;

/** SA-1063 A-1 MUST 7b: the most pending orders read before a sweep (a cart is never this deep). */
export const PENDING_ORDERS_READ_MAX = 50;

/** An order the customer already had pending before a sweep ran: what A-1 needs to see which one got folded. */
export interface PendingOrderRef {
  id: string;
  orderNumber: string;
}

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly deliveries: EmailDeliveryService,
    private readonly policies: PolicyService,
  ) {}

  /**
   * Effective mode for one tenant: the env ceiling (read at call time, the kill switch) min the tenant's
   * policy. An env of `off` returns before any policy read. A failed or invalid policy read is `dark`.
   */
  async getEffectiveMode(tenantId: string): Promise<StaffOrderEmailMode> {
    const env = process.env.STAFF_ORDER_EMAIL;
    if (env === "off") return "off";
    const policy = await this.policies.resolve(tenantId, "notifications.staffOrderEmail", {});
    return effectiveStaffOrderEmailMode(env, policy);
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
  async notifyStaffEvent(
    event: NotificationEvent,
    ctx: { orderId: string; replaces?: string[] },
  ): Promise<void> {
    try {
      if (!(event in OPT_OUT_KEY)) return;
      const kind = event as StaffEvent;
      if (process.env.STAFF_ORDER_EMAIL === "off") return; // the kill switch: no query at all

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

      const mode = await this.getEffectiveMode(tenantId);
      if (mode === "off") return;

      const recipients = await this.resolveRecipientRows(tenantId);
      if (recipients.length === 0) return;
      const optedOut = await this.optedOutUserIds(recipients, OPT_OUT_KEY[kind], tenantId);

      const delivery = {
        tenantId,
        kind: kind as EmailKind,
        entityType: "Order",
        entityId: ctx.orderId,
      };
      const content = mode === "on" ? this.render(kind, order, ctx.replaces) : null;

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

  // ─── SA-1063: the buyer-event entry points (each NEVER rejects; call after commit, with `void`) ───────────────

  /** True when the order is a DRAFT, or its status cannot be read (then nothing is sent). */
  async orderIsDraft(orderId: string): Promise<boolean> {
    try {
      const o = (await this.prisma.forTenant().order.findFirst({
        where: { id: orderId },
        select: { status: true },
      })) as { status?: string } | null;
      return !o || o.status === "DRAFT";
    } catch {
      return true;
    }
  }

  /**
   * The customer's PENDING orders, read BEFORE a sweep (SA-1063 A-1 MUST 7b). The sweep keeps the newest order and
   * deletes the folded ones, so this is the only way to name them afterwards. Never rejects: a failed read gives
   * `[]` and the office gets today's new-order email. Env `off` gives `[]` with no query.
   */
  async pendingOrdersOf(customerId: string | null | undefined): Promise<PendingOrderRef[]> {
    try {
      if (process.env.STAFF_ORDER_EMAIL === "off" || !customerId) return [];
      const rows = (await this.prisma.forTenant().order.findMany({
        where: { customerId, status: "PENDING" },
        select: { id: true, orderNumber: true },
        orderBy: { createdAt: "desc" },
        take: PENDING_ORDERS_READ_MAX,
      })) as Array<{ id: string; orderNumber: string | null }>;
      return rows.map((r) => ({ id: r.id, orderNumber: String(r.orderNumber ?? r.id) }));
    } catch {
      return [];
    }
  }

  /** The same read for a route that only has the signed-in user (a template generate as CUSTOMER). */
  async pendingOrdersForUser(userId: string | null | undefined): Promise<PendingOrderRef[]> {
    try {
      if (process.env.STAFF_ORDER_EMAIL === "off" || !userId) return [];
      const customer = (await this.prisma.forTenant().customer.findFirst({
        where: { userId },
        select: { id: true },
      })) as { id: string } | null;
      return customer ? await this.pendingOrdersOf(customer.id) : [];
    } catch {
      return [];
    }
  }

  /**
   * A customer placed (or folded into) an order. The event comes from what staff were already told (delivery rows;
   * "told" is a STAFF_NEW_ORDER or a BUYER_ORDER_EDITED row, any status):
   *   survivor not told, an order it replaced was  -> BUYER_ORDER_EDITED naming both numbers (A-1: the new order wins the fold)
   *   survivor not told, nothing replaced          -> STAFF_NEW_ORDER
   *   survivor told, an order was folded or `merged` -> the plain edit email
   *   survivor told, nothing folded, not `merged`   -> nothing (an idempotent replay)
   * `pendingBefore` is the customer's pending orders read before the sweep; routes with no sweep pass `[]`.
   */
  async notifyBuyerOrderPlaced(
    orderId: string,
    opts: { merged: boolean; pendingBefore: PendingOrderRef[] },
  ): Promise<void> {
    try {
      if (process.env.STAFF_ORDER_EMAIL === "off") return;
      if (!(await this.shouldTell(orderId))) return;
      const told = await this.alreadyToldAny(orderId);
      const folded = await this.foldedAway(orderId, opts.pendingBefore);
      if (told) {
        if (folded.length > 0 || opts.merged) await this.sendEdited(orderId);
        return;
      }
      if (folded.length > 0) {
        await this.notifyStaffEvent(NotificationEvent.BUYER_ORDER_EDITED, {
          orderId,
          replaces: folded.map((p) => p.orderNumber),
        });
        return;
      }
      await this.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId });
    } catch (err) {
      this.logger.warn(`notifyBuyerOrderPlaced skipped: ${(err as Error)?.message}`);
    }
  }

  /** A customer edited an order (one email per order inside BUYER_EDIT_EMAIL_WINDOW_MS). */
  async notifyBuyerOrderEdited(orderId: string): Promise<void> {
    try {
      if (process.env.STAFF_ORDER_EMAIL === "off") return;
      if (!(await this.shouldTell(orderId))) return;
      await this.sendEdited(orderId);
    } catch (err) {
      this.logger.warn(`notifyBuyerOrderEdited skipped: ${(err as Error)?.message}`);
    }
  }

  /** A customer cancelled an order. `wasDraft` is read BEFORE the cancel: a draft sends nothing. */
  async notifyBuyerOrderCancelled(orderId: string, opts: { wasDraft: boolean }): Promise<void> {
    try {
      if (process.env.STAFF_ORDER_EMAIL === "off") return;
      if (!shouldNotifyStaffOfOrder({ principal: "CUSTOMER", isDraft: opts.wasDraft })) return;
      await this.notifyStaffEvent(NotificationEvent.BUYER_ORDER_CANCELLED, { orderId });
    } catch (err) {
      this.logger.warn(`notifyBuyerOrderCancelled skipped: ${(err as Error)?.message}`);
    }
  }

  /** The one named predicate, fed the order's CURRENT status (a draft is never a staff event). */
  private async shouldTell(orderId: string): Promise<boolean> {
    return shouldNotifyStaffOfOrder({
      principal: "CUSTOMER",
      isDraft: await this.orderIsDraft(orderId),
    });
  }

  private async sendEdited(orderId: string): Promise<void> {
    if (await this.alreadyTold(orderId, "BUYER_ORDER_EDITED", BUYER_EDIT_EMAIL_WINDOW_MS)) return;
    await this.notifyStaffEvent(NotificationEvent.BUYER_ORDER_EDITED, { orderId });
  }

  /** Told = a new-order or an edit row for the order, any status (a survivor's first row can be the edit row). */
  private async alreadyToldAny(orderId: string): Promise<boolean> {
    return (
      (await this.alreadyTold(orderId, "STAFF_NEW_ORDER")) ||
      (await this.alreadyTold(orderId, "BUYER_ORDER_EDITED"))
    );
  }

  /**
   * Orders of `pendingBefore` that the sweep folded into `survivorId`: not the survivor, no longer an order, and the
   * office was told about them. An order that still exists was not folded (a deferred sweep, another path).
   */
  private async foldedAway(
    survivorId: string,
    pendingBefore: PendingOrderRef[],
  ): Promise<PendingOrderRef[]> {
    try {
      return await this.readFoldedAway(survivorId, pendingBefore);
    } catch (err) {
      // Over-tell, never drop: without the fold facts the office still gets the plain email.
      this.logger.warn(`foldedAway read failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  private async readFoldedAway(
    survivorId: string,
    pendingBefore: PendingOrderRef[],
  ): Promise<PendingOrderRef[]> {
    const others = pendingBefore.filter((p) => p.id !== survivorId);
    const tenantId = this.prisma.getTenantId();
    if (others.length === 0 || !tenantId) return [];
    const ids = others.map((p) => p.id);
    const db = this.prisma.forTenant();
    const still = (await db.order.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })) as Array<{ id: string }>;
    const stillThere = new Set(still.map((o) => o.id));
    const gone = others.filter((p) => !stillThere.has(p.id));
    if (gone.length === 0) return [];
    const rows = (await db.emailDelivery.findMany({
      where: {
        tenantId,
        kind: { in: ["STAFF_NEW_ORDER", "BUYER_ORDER_EDITED"] },
        entityType: "Order",
        entityId: { in: gone.map((p) => p.id) },
      },
      select: { entityId: true },
    })) as Array<{ entityId: string | null }>;
    const toldIds = new Set(rows.map((r) => r.entityId));
    return gone.filter((p) => toldIds.has(p.id));
  }

  /** One indexed lookup (`[entityType, entityId]`) on the delivery rows: any status counts as "told". */
  private async alreadyTold(
    orderId: string,
    kind: StaffEvent,
    withinMs?: number,
  ): Promise<boolean> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return false;
    const row = await this.prisma.forTenant().emailDelivery.findFirst({
      where: {
        tenantId,
        kind,
        entityType: "Order",
        entityId: orderId,
        ...(withinMs ? { createdAt: { gte: new Date(Date.now() - withinMs) } } : {}),
      },
      select: { id: true },
    });
    return !!row;
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

  private render(
    kind: StaffEvent,
    order: Record<string, any>,
    replaces?: string[],
  ): { subject: string; html: string } {
    const number = String(order.orderNumber ?? order.id);
    const customer = String(order.customer?.businessName ?? order.customer?.name ?? "A customer");
    // The STORED total, never recomputed from line items (money discipline).
    const total = roundMoney(Number(order.total)).toFixed(2);
    const urgent = order.urgent === true || order.isUrgent === true;
    // A-1: a fold into a new number is one edit-kind email naming both; every other email is unchanged.
    const replaced =
      kind === "BUYER_ORDER_EDITED" && replaces && replaces.length > 0 ? replaces : null;
    const headline = replaced
      ? `Order ${number} replaces ${replaced.join(", ")}`
      : kind === "STAFF_NEW_ORDER"
        ? `New order ${number}`
        : kind === "BUYER_ORDER_EDITED"
          ? `Order ${number} was edited by the customer`
          : `Order ${number} was cancelled by the customer`;
    const subject = `${urgent ? "[URGENT] " : ""}${headline} - ${customer}`;
    const html =
      `<p>${escapeHtml(headline)}.</p>` +
      (replaced ? "<p>The customer's orders were combined.</p>" : "") +
      `<p>Customer: ${escapeHtml(customer)}<br>Order: ${escapeHtml(number)}<br>` +
      `Total: $${escapeHtml(total)}</p>`;
    return { subject, html };
  }
}
