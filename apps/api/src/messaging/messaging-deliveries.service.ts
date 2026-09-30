import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { requireTenantContext } from "./require-tenant-context";
import { EmailDeliveryStatus } from "@prisma/client";
import { EMAIL_KINDS, type EmailKind } from "../email/email-kinds";
import type { DeliveryFixKey, DeliveryHealth, DeliveryList } from "@routeflow/types";

/** Local literal copy (the API never value-imports `@routeflow/types`); pinned equal to the shared
 *  `DELIVERY_FIX_KEY_VALUES` by `messaging-deliveries-parity.spec.ts`. */
export const DELIVERY_FIX_KEY_VALUES = [
  "NO_FROM_ADDRESS",
  "MAILBOX_REVOKED",
  "SMTP_AUTH",
  "UNCONFIGURED",
  "OTHER",
] as const satisfies readonly DeliveryFixKey[];

const EMAIL_DELIVERY_STATUS_VALUES = Object.values(EmailDeliveryStatus) as EmailDeliveryStatus[];

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_WINDOW_DAYS = 30;
const HEALTH_WINDOW_DAYS = 7;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const FAILURE_SAMPLE = 1000;

/** A stored kind outside the allow-list (older/foreign rows) is shown as AUTH_OTHER. */
function safeKind(kind: string): EmailKind {
  return (EMAIL_KINDS as readonly string[]).includes(kind) ? (kind as EmailKind) : "AUTH_OTHER";
}

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
    requireTenantContext(this.prisma);
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
        kind: safeKind(r.kind),
        toAddress: full ? r.toAddress : maskEmail(r.toAddress),
        status: r.status as EmailDeliveryStatus,
        // Raw (redacted, ≤500) provider text: TENANT_ADMIN only — an OPERATOR sees the status and the
        // closed fixKey (health), never the text.
        error: full ? r.error : null,
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
    requireTenantContext(this.prisma);
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
