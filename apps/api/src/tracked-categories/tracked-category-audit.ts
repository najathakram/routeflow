import { Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * Row 430 (SA-958 §3.2): a tracked category holds regulated tax rates, so each write leaves one AuditLog row, written
 * with `tx.auditLog.create` in the SAME transaction as the write (never `AuditService.log`, which swallows a failure).
 */
export interface TrackedCategoryActor {
  sub: string;
  impersonatedBy?: string | null;
}

/** The columns a regulator or an accountant asks about: what is taxed, at what rate, and whether it is live. */
const AUDITED_FIELDS = [
  "name",
  "taxType",
  "rate",
  "unitBasis",
  "priceIncludesTax",
  "invoiceTreatment",
  "requiresLicense",
  "active",
] as const;

type Snapshot = Record<(typeof AUDITED_FIELDS)[number], unknown>;

/** A Decimal rate reads as its plain number string ("0.05", not "0.0500"), so before and after compare and print alike. */
const plainRate = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number") return String(Number(v));
  if (v instanceof Prisma.Decimal) return String(v.toNumber());
  return "0";
};

export function trackedCategorySnapshot(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const out = {} as Snapshot;
  for (const f of AUDITED_FIELDS) out[f] = f === "rate" ? plainRate(row[f]) : (row[f] ?? null);
  return out;
}

export async function auditTrackedCategoryWrite(
  tx: Pick<Prisma.TransactionClient, "auditLog">,
  args: {
    tenantId: string;
    actor: TrackedCategoryActor | null | undefined;
    created: boolean;
    before: Record<string, unknown> | null | undefined;
    after: Record<string, unknown>;
    /** Where no signed-in user acts (the first-tobacco auto-seed), say so instead of leaving the row anonymous. */
    via?: string;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.actor?.sub ?? null,
      impersonatedBy: args.actor?.impersonatedBy ?? null,
      action: args.created
        ? AUDIT_ACTIONS.TRACKED_CATEGORY_CREATED
        : AUDIT_ACTIONS.TRACKED_CATEGORY_UPDATED,
      entityType: "TrackedCategory",
      entityId: String(args.after.id),
      meta: {
        before: args.created ? null : trackedCategorySnapshot(args.before),
        after: trackedCategorySnapshot(args.after),
        ...(args.via ? { via: args.via } : {}),
      } as Prisma.InputJsonValue,
    },
  });
}
