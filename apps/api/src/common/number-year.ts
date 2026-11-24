import { tenantTodayDay } from "./calendar-date";
import { tenantTimeZone } from "./tenant-time-zone";

/**
 * W-1188 / W-1199: the year segment of EVERY document number (invoice, estimate, credit note, return, PO, bill,
 * commission statement, and the settings preview) is the tenant's calendar year at mint time (entry sequence, entry
 * year; never the issue year), never the server clock's. Read through the caller's tx when it has one, so this never
 * asks the pool for a second connection while that tx holds one (REG-B100-C).
 *
 * A caller with no tenant id falls back to the db's ambient tenant when it has one (the pooled service), else UTC;
 * a bare tx has no `getTenantId`, so it never throws for a missing id.
 */
export async function numberYear(db: any, tenantId?: string | null): Promise<number> {
  const id = tenantId || (typeof db?.getTenantId === "function" ? db.getTenantId() : null) || null;
  const zone = id ? await tenantTimeZone(db, { tenantId: id }) : null;
  return Number(tenantTodayDay(zone).slice(0, 4));
}
