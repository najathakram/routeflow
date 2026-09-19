/**
 * B587 — the tenant's next `ORD-#####` order number.
 *
 * The old generator took the lexicographically LARGEST `ORD-*` order number and `parseInt`-ed the
 * rest. A seeded tenant (`ORD-SEED-1`), or any number that is not `ORD-<digits>`, sorts above every
 * numeric one, so `parseInt` gave NaN, the fallback `1` collided with the existing `ORD-00001` on
 * `@@unique([tenantId, orderNumber])`, every retry recomputed the same value, and POST /orders 500'd
 * forever after the first create. (`ORD-9` also sorts above `ORD-00010` as text.)
 *
 * Now the sequence is the NUMERIC maximum over the tenant's own conforming numbers only:
 * `ORD-` + 1..9 digits. Anything else — `ORD-SEED-1`, `ORD-` alone, a 13-digit `ORD-<epoch ms>`
 * minted by the template generator, a trailing junk suffix — is not part of the sequence and is
 * ignored, never parsed and never a crash.
 */
export const ORDER_NUMBER_PREFIX = "ORD-";
/** Postgres regex for a sequence number (`~`); the 9-digit cap keeps the bigint cast overflow-proof. */
export const ORDER_SEQ_PATTERN = "^ORD-[0-9]{1,9}$";
const ORDER_SEQ_JS = /^ORD-([0-9]{1,9})$/;
/** Highest sequence the 9-digit pattern still recognises; one more would fall OUT of the sequence. */
const MAX_SEQ = 999_999_999;
const PAD = 5;

/** The numeric part of a conforming order number, else null. */
export function parseOrderSeq(orderNumber: string | null | undefined): number | null {
  const m = ORDER_SEQ_JS.exec(orderNumber ?? "");
  return m ? Number(m[1]) : null;
}

/** `ORD-` + the sequence, zero-padded to 5 (it grows past 99,999). No/invalid max => `ORD-00001`. */
export function nextOrderNumber(maxSeq: number | bigint | string | null | undefined): string {
  const n = Number(maxSeq);
  const next = maxSeq != null && Number.isFinite(n) && n >= 0 ? Math.trunc(n) + 1 : 1;
  // Past 999,999,999 the number would have 10 digits, stop matching the pattern, and the next
  // create would recompute the SAME number and 500 forever (B587's mechanism) — fail loudly instead.
  if (next > MAX_SEQ) throw new RangeError("Order number sequence exhausted (ORD-999999999)");
  return `${ORDER_NUMBER_PREFIX}${String(next).padStart(PAD, "0")}`;
}

interface RawTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Next order number for `tenantId` (null = a tenant-less caller: all tenants, as the old lookup
 * behaved). Run INSIDE the create transaction so a P2002 retry re-reads the fresh maximum.
 */
export async function nextOrderNumberFor(tx: RawTx, tenantId: string | null): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ max: bigint | number | string | null }>>`
    SELECT MAX(CASE WHEN "orderNumber" ~ ${ORDER_SEQ_PATTERN}
                    THEN CAST(substring("orderNumber" from 5) AS bigint) END) AS max
    FROM "Order"
    WHERE (${tenantId}::text IS NULL OR "tenantId" = ${tenantId})`;
  return nextOrderNumber(rows?.[0]?.max);
}
