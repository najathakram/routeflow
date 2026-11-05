/**
 * Ops item 545: READ-ONLY report on why one tenant's admin may not be getting the daily low-stock digest.
 * It counts the things `LowStockDigestService` decides on, through the same rules (`low-stock-digest-rules.ts`), and
 * says what the code remembers about past sends. `apps/api/scripts/report-low-stock-digest.mjs` is the thin runner
 * (read-only session, ROLLBACK).
 *
 * COUNTS ONLY. Nothing returned is a name, an email address, a product, a tenant id or an amount. The one date is the
 * tenant-local day the cron last marked processed. Every query here is a count, or a read of numbers and addresses
 * that are reduced to counts in memory and never returned.
 */
import { RECORD_KEEPING_EXCLUDED_STATUSES } from "../tenant/tenant-automation";
import { resolveZone } from "../common/tenant-time-zone";
import {
  dedupeMailboxes,
  digestOptOutWhere,
  digestRecipientWhere,
  isBelowReorderPoint,
  lowStockProductWhere,
} from "./low-stock-digest-rules";

/** The `EmailDelivery.kind` a digest would be recorded under, if the send recorded one (it does not today). */
const DIGEST_DELIVERY_KIND = "LOW_STOCK_DIGEST";

export interface LowStockDigestReport {
  tenant: {
    found: boolean;
    /** The cron skips deleted tenants and those in `RECORD_KEEPING_EXCLUDED_STATUSES`. */
    cronVisits: boolean;
    status: string | null;
  };
  timezone: {
    /** The zone the tenant's config holds; null when it has no row, no value, or a value that is not a real zone. */
    stored: string | null;
    /** What the cron uses: the stored zone, or UTC when the stored one is missing or not a real zone. */
    used: string | null;
    fellBackToUtc: boolean;
  };
  products: {
    /** Active products: the pool every count below is drawn from. */
    active: number;
    /** Active products with a reorder point. Products without one never alert. */
    withReorderPoint: number;
    /** Of those, stock strictly below the reorder point: what the digest would list today. */
    belowReorderPoint: number;
  };
  recipients: {
    /** Active, undeleted TENANT_ADMIN and OPERATOR users. */
    adminsAndOperators: number;
    /** Of those, with an email on file. */
    withEmail: number;
    /** Of those with an email, opted out of the digest. */
    optedOut: number;
    /** Distinct mailboxes the cron would send to: with an email, not opted out, one per mailbox. */
    mailboxesToSend: number;
  };
  sendRecord: {
    /** The tenant-local day the cron last marked processed (YYYY-MM-DD), or null. */
    lastProcessedDay: string | null;
    /** The day mark is written whether or not any mail was sent, so it is not proof of a send. */
    dayMarkProvesSend: false;
    /** `EmailDelivery` rows of the digest kind for this tenant. The digest send passes no delivery record. */
    deliveryRows: number;
    note: string;
  };
}

/** The slice of the Prisma client this report reads: nothing here can write. */
export interface LowStockDigestReportDb {
  tenant: { findFirst(args: unknown): Promise<unknown> };
  tenantConfig: { findUnique(args: any): Promise<{ timezone?: string | null } | null> };
  product: { count(args: unknown): Promise<number>; findMany(args: unknown): Promise<unknown[]> };
  user: { findMany(args: unknown): Promise<unknown[]> };
  userPreference: { findMany(args: unknown): Promise<unknown[]> };
  emailDelivery: { count(args: unknown): Promise<number> };
}

type TenantRow = {
  status: string;
  deletedAt: Date | null;
  config: { lowStockDigestSentForDay: Date | null } | null;
} | null;

export async function reportLowStockDigest(
  db: LowStockDigestReportDb,
  tenantId: string,
): Promise<LowStockDigestReport> {
  const tenant = (await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      status: true,
      deletedAt: true,
      config: { select: { lowStockDigestSentForDay: true } },
    },
  })) as TenantRow;

  // SA-738r: the zone is read only through the resolver (one more read-only lookup on the tenant's config).
  const resolved = tenant ? await resolveZone(db, { tenantId }) : null;
  const stored = resolved && !resolved.fallback ? resolved.zone : null;

  const active = await db.product.count({ where: { tenantId, isActive: true } });
  const withPoint = (await db.product.findMany({
    where: lowStockProductWhere(tenantId),
    select: { currentStock: true, reorderPoint: true },
  })) as { currentStock: unknown; reorderPoint: number | null }[];

  const staff = (await db.user.findMany({
    where: digestRecipientWhere(tenantId),
    select: { id: true, email: true },
  })) as { id: string; email: string | null }[];
  const withEmail = staff.filter((a) => a.email) as { id: string; email: string }[];
  const optOuts = withEmail.length
    ? ((await db.userPreference.findMany({
        where: digestOptOutWhere(withEmail.map((a) => a.id)),
        select: { userId: true },
      })) as { userId: string }[])
    : [];
  const optedOutIds = new Set(optOuts.map((o) => o.userId));
  const optedIn = withEmail.filter((a) => !optedOutIds.has(a.id));

  const deliveryRows = await db.emailDelivery.count({
    where: { tenantId, kind: DIGEST_DELIVERY_KIND },
  });
  const day = tenant?.config?.lowStockDigestSentForDay ?? null;

  return {
    tenant: {
      found: !!tenant,
      cronVisits:
        !!tenant &&
        tenant.deletedAt === null &&
        !(RECORD_KEEPING_EXCLUDED_STATUSES as readonly string[]).includes(tenant.status),
      status: tenant?.status ?? null,
    },
    timezone: {
      stored,
      used: resolved?.zone ?? null,
      fellBackToUtc: resolved?.fallback ?? false,
    },
    products: {
      active,
      withReorderPoint: withPoint.length,
      belowReorderPoint: withPoint.filter(isBelowReorderPoint).length,
    },
    recipients: {
      adminsAndOperators: staff.length,
      withEmail: withEmail.length,
      optedOut: withEmail.length - optedIn.length,
      mailboxesToSend: dedupeMailboxes(optedIn).length,
    },
    sendRecord: {
      lastProcessedDay: day ? day.toISOString().slice(0, 10) : null,
      dayMarkProvesSend: false,
      deliveryRows,
      note:
        deliveryRows === 0
          ? "No per-send record is kept: the digest passes no delivery row, and the day mark is written even when nothing was sent."
          : "Delivery rows exist for this kind; the day mark is still written even when nothing was sent.",
    },
  };
}
