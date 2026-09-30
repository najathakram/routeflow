import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  DELIVERY_FIX_KEY_VALUES,
  EMAIL_DELIVERY_STATUS_VALUES,
  type DeliveryFixKey,
  type DeliveryHealth,
  type DeliveryList,
  type EmailDeliveryStatus,
} from "@routeflow/types";

export { DELIVERY_FIX_KEY_VALUES };

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_WINDOW_DAYS = 30;
const HEALTH_WINDOW_DAYS = 7;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const FAILURE_SAMPLE = 1000;

/** `jane@x.com` -> `j***@x.com` (never leaks the local part beyond its first char). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Closed mapper from a stored (already redacted) error to a fix key; null in, null out. */
export function fixKeyForError(error: string | null | undefined): DeliveryFixKey | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes("from email")) return "NO_FROM_ADDRESS";
  if (e.includes("revoked")) return "MAILBOX_REVOKED";
  if (/\b535\b/.test(e) || e.includes("auth")) return "SMTP_AUTH";
  if (e.includes("not configured")) return "UNCONFIGURED";
  return "OTHER";
}

export interface ListDeliveriesQuery {
  status?: EmailDeliveryStatus;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class MessagingDeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(role: string, query: ListDeliveriesQuery): Promise<DeliveryList> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(query.pageSize) || DEFAULT_PAGE_SIZE)),
    );
    const where: Record<string, unknown> = {
      createdAt: { gte: new Date(Date.now() - LIST_WINDOW_DAYS * DAY_MS) },
    };
    if (query.status) where.status = query.status;

    const db = this.prisma.forTenant();
    const [rows, total] = await Promise.all([
      db.emailDelivery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.emailDelivery.count({ where }),
    ]);
    const full = role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        toAddress: full ? r.toAddress : maskEmail(r.toAddress),
        status: r.status as EmailDeliveryStatus,
        error: r.error,
        entityType: r.entityType,
        entityId: r.entityId,
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      })),
      page,
      pageSize,
      total,
    };
  }

  async health(): Promise<DeliveryHealth> {
    const since = { gte: new Date(Date.now() - HEALTH_WINDOW_DAYS * DAY_MS) };
    const db = this.prisma.forTenant();
    const [grouped, failedRows] = await Promise.all([
      db.emailDelivery.groupBy({
        by: ["status"],
        where: { createdAt: since },
        _count: { _all: true },
      }),
      db.emailDelivery.findMany({
        where: { createdAt: since, status: "FAILED" },
        select: { error: true },
        take: FAILURE_SAMPLE,
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const counts = Object.fromEntries(EMAIL_DELIVERY_STATUS_VALUES.map((s) => [s, 0])) as Record<
      EmailDeliveryStatus,
      number
    >;
    for (const g of grouped as { status: EmailDeliveryStatus; _count: { _all: number } }[]) {
      counts[g.status] = g._count._all;
    }
    const byKey = new Map<DeliveryFixKey, number>();
    for (const r of failedRows as { error: string | null }[]) {
      const key = fixKeyForError(r.error);
      if (key) byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    return {
      windowDays: HEALTH_WINDOW_DAYS,
      counts,
      failures: DELIVERY_FIX_KEY_VALUES.filter((k) => byKey.has(k)).map((k) => ({
        fixKey: k,
        count: byKey.get(k) as number,
      })),
    };
  }
}
