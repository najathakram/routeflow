import { counterCloseKeyOf } from "../../../returns/counter-close-lock";

/**
 * The close's own lock: the EXCLUSIVE form of the key the tender, the pickup, the refunds and the void take shared
 * (`lockCounterClose`). The close waits for every write in flight, reads its cutoff after the grant, and lets nothing in until it
 * commits. `SET LOCAL lock_timeout` bounds the wait; it must precede the lock. Takes no other lock and no FOR UPDATE.
 */
export async function lockCounterCloseExclusive(
  tx: { $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<unknown> },
  tenantId: string,
  registerKey: string,
): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext(${counterCloseKeyOf(tenantId, registerKey)}))`;
}

/** Postgres `lock_not_available` (55P03), however Prisma wraps it. */
export function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  return (
    e?.code === "55P03" || e?.meta?.code === "55P03" || /55P03|lock timeout/i.test(e?.message ?? "")
  );
}

/** A unique-constraint violation (Prisma P2002, or the raw 23505). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null;
  return e?.code === "P2002" || e?.code === "23505" || e?.meta?.code === "23505";
}
