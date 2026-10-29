import type { PrismaService } from "../prisma/prisma.service";
import {
  STRIPE_CHECKOUT_APPLIED_ACTION,
  STRIPE_CHECKOUT_ENTITY,
  STRIPE_CHECKOUT_LINK_ENTITY,
  STRIPE_CHECKOUT_LINKED_ACTION,
  STRIPE_CHECKOUT_UNLINKED_ACTION,
} from "./config-snapshot-audit.constants";

/** The slice of a Prisma client (or transaction) `isLinkPending` reads: the audit trail only. */
export type LinkPendingClient = Pick<PrismaService, "auditLog">;

function sessionIdOf(meta: unknown): string | null {
  if (meta == null || typeof meta !== "object") return null;
  const id = (meta as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * SA-774 r6: is the tenant's Stripe subscription LINKED but not yet ACTIVATED (a card or bank payment
 * still clearing)? True when the newest LINKED marker for this subscription id has no UNLINKED marker
 * after it and its session has no ACTIVATED marker (`STRIPE_CHECKOUT_APPLIED`, keyed by the session id).
 *
 * It is read from the audit trail, never from `stripeSubId != null`: `extendTrial` leaves stale ids, and a
 * legacy row has a subscription id and no marker. A marker whose session id cannot be read is NOT link-pending
 * (today's behaviour), so a bad row can never lock a tenant out of self-serve billing.
 */
export async function isLinkPending(
  client: LinkPendingClient,
  tenantId: string,
  stripeSubId: string | null | undefined,
): Promise<boolean> {
  if (!stripeSubId) return false;
  const base = { tenantId, entityType: STRIPE_CHECKOUT_LINK_ENTITY, entityId: stripeSubId };
  const orderBy = { createdAt: "desc" as const };
  const linked = await client.auditLog.findFirst({
    where: { ...base, action: STRIPE_CHECKOUT_LINKED_ACTION },
    orderBy,
    select: { meta: true, createdAt: true },
  });
  if (!linked) return false;
  const unlinked = await client.auditLog.findFirst({
    where: { ...base, action: STRIPE_CHECKOUT_UNLINKED_ACTION },
    orderBy,
    select: { createdAt: true },
  });
  if (unlinked && unlinked.createdAt.getTime() >= linked.createdAt.getTime()) return false;
  const sessionId = sessionIdOf(linked.meta);
  if (!sessionId) return false;
  const activated = await client.auditLog.findFirst({
    where: {
      tenantId,
      entityType: STRIPE_CHECKOUT_ENTITY,
      entityId: sessionId,
      action: STRIPE_CHECKOUT_APPLIED_ACTION,
    },
    select: { id: true },
  });
  return activated == null;
}
