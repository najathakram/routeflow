import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * The hand-over claim row (an AuditLog row, action PICKUP_COMPLETE_CLAIM) carries the completion email's state in its
 * `meta`. SA-909:
 *  - EVERY write to that meta is an atomic jsonb merge of its own keys (`mergeClaimMeta`), never a read-modify-write of the
 *    whole object: a writer that read `meta` before another's write and wrote after it would erase that write (a reservation,
 *    the emailed flag, the key).
 *  - The email is sent once PER COMPLETION: `completionEmailedFor` = that completion's `deliveredAt` (ISO). A different key on
 *    the same completion finds it and sends nothing; a re-completion after a reopen has a new `deliveredAt` and sends one.
 *  - The send is RESERVED by one conditional update (`completionEmailClaim = { for, at }` where nothing is emailed for this
 *    completion and no live claim exists) and runs with NO lock held (the counter-tender pool is 4 slots shared by every
 *    till). A claim older than the lease is a crashed sender's: it may be taken over.
 */
type Db = Pick<PrismaService, "$executeRaw" | "$queryRaw">;

/** A crashed sender's reservation is honoured this long, then the next call may take it over. */
export const COMPLETION_EMAIL_LEASE_MINUTES = 10;

/** Merge `patch` into the claim row's meta in one statement (tenant-scoped). */
export async function mergeClaimMeta(
  db: Db,
  tenantId: string,
  claimId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "AuditLog" SET "meta" = COALESCE("meta", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE "id" = ${claimId} AND "tenantId" = ${tenantId}`;
}

/**
 * Reserve this completion's email. Returns the reservation's `at` (this call won) or null (emailed already, or another
 * call holds a live claim): one conditional update, so two concurrent callers cannot both win.
 */
export async function reserveCompletionEmail(
  db: Db,
  tenantId: string,
  claimId: string,
  completionFor: string,
): Promise<string | null> {
  const rows: Array<{ at: string }> = await db.$queryRaw`
    UPDATE "AuditLog"
    SET "meta" = COALESCE("meta", '{}'::jsonb) || jsonb_build_object(
      'completionEmailClaim', jsonb_build_object('for', ${completionFor}::text, 'at', to_jsonb(now()))
    )
    WHERE "id" = ${claimId} AND "tenantId" = ${tenantId}
      AND ("meta"->>'completionEmailedFor') IS DISTINCT FROM ${completionFor}::text
      AND (
        "meta"->'completionEmailClaim' IS NULL
        OR ("meta"->'completionEmailClaim'->>'for') IS DISTINCT FROM ${completionFor}::text
        OR ("meta"->'completionEmailClaim'->>'at')::timestamptz
             < now() - make_interval(mins => ${COMPLETION_EMAIL_LEASE_MINUTES}::int)
      )
    RETURNING "meta"->'completionEmailClaim'->>'at' AS "at"`;
  return rows[0]?.at ?? null;
}

/** A delivered send: the flag for this completion, the reservation removed (one statement). */
export async function finishCompletionEmail(
  db: Db,
  tenantId: string,
  claimId: string,
  completionFor: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "AuditLog"
    SET "meta" = (COALESCE("meta", '{}'::jsonb) - 'completionEmailClaim')
      || jsonb_build_object('completionEmailedFor', ${completionFor}::text)
    WHERE "id" = ${claimId} AND "tenantId" = ${tenantId}`;
}

/** A failed send: remove the reservation only if it is still this call's, so the same-key retry can send. */
export async function releaseCompletionEmail(
  db: Db,
  tenantId: string,
  claimId: string,
  completionFor: string,
  at: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "AuditLog" SET "meta" = "meta" - 'completionEmailClaim'
    WHERE "id" = ${claimId} AND "tenantId" = ${tenantId}
      AND "meta"->'completionEmailClaim'->>'for' = ${completionFor}::text
      AND "meta"->'completionEmailClaim'->>'at' = ${at}::text`;
}

/**
 * SA-909 item 4: the #2088 send record is the delivery fact (written right after the provider accepts, before markSent):
 * a COUNTER_COMPLETE send record of the completion's first invoice at or after this completion's `deliveredAt` means the
 * email went, even if the flag never got written (markSent threw). Residual (documented): that record's own best-effort
 * write failed AND markSent threw: a second email in that double failure only.
 */
export async function completionAlreadyRecorded(
  db: Pick<PrismaService, "forTenant">,
  tenantId: string,
  firstInvoiceId: string,
  deliveredAt: Date,
): Promise<boolean> {
  const row = await db.forTenant().auditLog.findFirst({
    where: {
      tenantId,
      entityType: "invoice",
      entityId: firstInvoiceId,
      action: AUDIT_ACTIONS.INVOICE_EMAILED,
      createdAt: { gte: deliveredAt },
      meta: { path: ["kind"], equals: "COUNTER_COMPLETE" },
    },
    select: { id: true },
  });
  return !!row;
}
