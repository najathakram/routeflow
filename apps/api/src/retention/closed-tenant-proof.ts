import { Prisma } from "@prisma/client";
import { isApprovedTestTenantSlug } from "../common/tenant-class.util";

/** SA-1083: days a tenant stays closed, and days since its closing notice, before a purge can be proven. */
export const CLOSED_TENANT_WAIT_DAYS = 30;
export const CLOSING_NOTICE_WAIT_DAYS = 30;
const DAY_MS = 86_400_000;

/** The one reason that makes READ_ONLY a closed state. The trigger `tenant_closed_clock` holds the same test. */
const CLOSED_READ_ONLY_REASON = "subscription_cancelled";

export function isClosedTenantState(t: {
  status: string;
  readOnlyReason: string | null | undefined;
}): boolean {
  return (
    t.status === "CANCELLED" ||
    (t.status === "READ_ONLY" && t.readOnlyReason === CLOSED_READ_ONLY_REASON)
  );
}

export type ClosedTenantRefusalReason =
  | "TENANT_NOT_FOUND"
  | "NOT_CLOSED"
  | "NO_CLOSED_DATE"
  | "CLOSED_TOO_RECENTLY"
  | "ON_HOLD"
  | "NO_APPROVAL"
  | "APPROVAL_BEFORE_CLOSING"
  | "NO_NOTICE"
  | "NOTICE_BEFORE_CLOSING"
  | "NOTICE_TOO_RECENT"
  | "COPY_REQUEST_OPEN"
  | "TENANT_CLASS_REFUSED"
  | "STRIPE_SUBSCRIPTION_CHANGED";

export class ClosedTenantRefused extends Error {
  constructor(
    readonly reason: ClosedTenantRefusalReason,
    readonly tenantId: string,
  ) {
    super(`Tenant ${tenantId}: purge refused (${reason})`);
    this.name = "ClosedTenantRefused";
  }
}

declare const closedTenantProofBrand: unique symbol;

/** Only `proveClosedTenant` makes one, so a purge function that requires it can't be called without the checks. */
export interface ClosedTenantProof {
  readonly tenantId: string;
  readonly closedAt: Date;
  readonly provenAt: Date;
  readonly [closedTenantProofBrand]: true;
}

/** DEMO, INTERNAL and the standing test tenants are never purged. A throwaway `qa-*` tenant can be, for rehearsal. */
export function tenantClassAllowsPurge(t: { class: string; slug: string }): boolean {
  if (t.class === "DEMO" || t.class === "INTERNAL") return false;
  if (isApprovedTestTenantSlug(t.slug)) return t.slug.startsWith("qa-");
  return t.class === "PRODUCTION";
}

type JudgedTenant = {
  slug: string;
  class: string;
  status: string;
  readOnlyReason: string | null;
  closedAt: Date | null;
  retentionHoldAt: Date | null;
  purgeApprovedAt: Date | null;
  purgeNoticeAt: Date | null;
  copyRequestOpenAt: Date | null;
};

/** Every refusal except the Stripe compare, which needs the transaction. null means nothing refuses it. */
export function closedTenantRefusal(t: JudgedTenant, now: Date): ClosedTenantRefusalReason | null {
  if (!tenantClassAllowsPurge(t)) return "TENANT_CLASS_REFUSED";
  if (!isClosedTenantState(t)) return "NOT_CLOSED";
  if (!t.closedAt) return "NO_CLOSED_DATE";
  if (now.getTime() - t.closedAt.getTime() < CLOSED_TENANT_WAIT_DAYS * DAY_MS) {
    return "CLOSED_TOO_RECENTLY";
  }
  if (t.retentionHoldAt) return "ON_HOLD";
  if (t.copyRequestOpenAt) return "COPY_REQUEST_OPEN";
  if (!t.purgeNoticeAt) return "NO_NOTICE";
  if (t.purgeNoticeAt < t.closedAt) return "NOTICE_BEFORE_CLOSING";
  if (now.getTime() - t.purgeNoticeAt.getTime() < CLOSING_NOTICE_WAIT_DAYS * DAY_MS) {
    return "NOTICE_TOO_RECENT";
  }
  if (!t.purgeApprovedAt) return "NO_APPROVAL";
  if (t.purgeApprovedAt <= t.closedAt) return "APPROVAL_BEFORE_CLOSING";
  return null;
}

/**
 * SA-1083: the one proof a purge function can run on, read under the tenant row lock, and re-proved for each batch.
 * `stripeRead` is the result of `stripeGateBeforeTermination`, which refuses a live subscription and runs before the
 * transaction because Stripe is never called under this lock. Its id is compared here, as `deleteTenant` does.
 */
export async function proveClosedTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
  stripeRead: { stripeSubId: string | null },
): Promise<ClosedTenantProof> {
  if (!tenantId) throw new Error("proveClosedTenant needs a tenant id");
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      slug: true,
      class: true,
      status: true,
      readOnlyReason: true,
      closedAt: true,
      retentionHoldAt: true,
      purgeApprovedAt: true,
      purgeNoticeAt: true,
      copyRequestOpenAt: true,
    },
  });
  if (!tenant) throw new ClosedTenantRefused("TENANT_NOT_FOUND", tenantId);
  const refusal = closedTenantRefusal(tenant, now);
  if (refusal) throw new ClosedTenantRefused(refusal, tenantId);
  const sub = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { stripeSubId: true },
  });
  if ((sub?.stripeSubId ?? null) !== stripeRead.stripeSubId) {
    throw new ClosedTenantRefused("STRIPE_SUBSCRIPTION_CHANGED", tenantId);
  }
  return { tenantId, closedAt: tenant.closedAt as Date, provenAt: now } as ClosedTenantProof;
}
