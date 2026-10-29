import { InvoiceStatus } from "@prisma/client";
import { badDebtPreTax, roundMoney } from "@routeflow/pricing";
import { ensureWriteOffEvent } from "./invoice-write-off";

/**
 * SA-1050 PR-1: the backfill of the bad-debt ledger for WRITTEN_OFF invoices that predate it (rule 3, rule 4).
 *
 * The one writer is `ensureWriteOffEvent` (invoice-write-off.ts); this module only PLANS (reads through the Prisma model
 * API, no raw SQL) and then calls it, one invoice per transaction. `apps/api/scripts/backfill-write-off-events.mjs` is its
 * CLI (dry run by default; the prod `--apply` is the owner's). The plan reports, per tenant and per month, the OLD figure
 * (the live B456 formula: terms summed unrounded, then rounded) beside the NEW one (per-invoice rounding, rule 4), so the
 * owner sees every month's half-cent move before applying; undated rows (imports, F-8) sit in no month.
 */
export interface BackfillDb {
  invoice: { findMany(args: any): Promise<any[]> };
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export interface BackfillMonth {
  tenantId: string;
  /** `YYYY-MM` of `writtenOffAt` (UTC), or `undated`. */
  month: string;
  invoices: number;
  oldExpense: number;
  newExpense: number;
}

export interface BackfillPlan {
  /** WRITTEN_OFF invoices with no event, with a tenant and something owing: the ones `apply` will give an event. */
  invoiceIds: string[];
  /** The same ids, by tenant (the per-tenant counts, and the protected-tenant hold on an all-tenants apply). */
  idsByTenant: Map<string, string[]>;
  months: BackfillMonth[];
  /** WRITTEN_OFF with no event and a confirmedBalance of 0: no row is written (an event is `amount > 0`). */
  nothingDue: number;
  /** WRITTEN_OFF with no event and NO tenant: refused, never guessed (the append needs the locked row's tenant). */
  nullTenant: number;
  /** Every WRITTEN_OFF invoice in scope, evented or not. */
  scanned: number;
}

const monthOf = (d: Date | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 7) : "undated";

/** The plan (read only). `tenantId` scopes it to one tenant; omitted = every tenant. */
export async function planWriteOffBackfill(
  db: BackfillDb,
  opts: { tenantId?: string } = {},
): Promise<BackfillPlan> {
  const scope = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const written: any[] = await db.invoice.findMany({
    where: { status: InvoiceStatus.WRITTEN_OFF, ...scope },
    select: {
      id: true,
      tenantId: true,
      total: true,
      taxAmount: true,
      writtenOffAt: true,
      writeOffEvents: { select: { id: true }, take: 1 },
      payments: { where: { status: "PAID" }, select: { amount: true } },
    },
    orderBy: { id: "asc" },
  });

  const plan: BackfillPlan = {
    invoiceIds: [],
    idsByTenant: new Map(),
    months: [],
    nothingDue: 0,
    nullTenant: 0,
    scanned: written.length,
  };
  // old = the unrounded term summed per (tenant, month) then rounded; new = each invoice rounded, then summed.
  const buckets = new Map<string, { m: BackfillMonth; oldRaw: number }>();
  for (const inv of written) {
    if (inv.writeOffEvents.length > 0) continue;
    if (!inv.tenantId) {
      plan.nullTenant += 1;
      continue;
    }
    const paid = inv.payments.reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
    const total = Number(inv.total ?? 0);
    const owing = Math.max(0, roundMoney(total - paid));
    if (owing <= 0) {
      plan.nothingDue += 1;
      continue;
    }
    plan.invoiceIds.push(inv.id);
    plan.idsByTenant.set(inv.tenantId, [...(plan.idsByTenant.get(inv.tenantId) ?? []), inv.id]);

    const month = monthOf(inv.writtenOffAt);
    const key = `${inv.tenantId}|${month}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        m: { tenantId: inv.tenantId, month, invoices: 0, oldExpense: 0, newExpense: 0 },
        oldRaw: 0,
      };
      buckets.set(key, b);
    }
    const tax = Number(inv.taxAmount ?? 0);
    b.m.invoices += 1;
    b.oldRaw += Math.max(0, total - paid) * (total > 0 ? (total - tax) / total : 0);
    b.m.newExpense = roundMoney(b.m.newExpense + badDebtPreTax(owing, total, tax));
  }
  for (const { m, oldRaw } of buckets.values()) {
    m.oldExpense = roundMoney(oldRaw);
    plan.months.push(m);
  }
  plan.months.sort((a, b) =>
    a.tenantId === b.tenantId
      ? a.month.localeCompare(b.month)
      : a.tenantId.localeCompare(b.tenantId),
  );
  return plan;
}

export interface BackfillApplyResult {
  written: number;
  skipped: number;
  failed: Array<{ invoiceId: string; message: string }>;
}

/**
 * Give each planned invoice its event through `ensureWriteOffEvent`, one transaction per invoice (a failure rolls back
 * only that invoice and is reported). A rerun writes 0: the writer skips an invoice that already has an event.
 */
export async function applyWriteOffBackfill(
  db: BackfillDb,
  invoiceIds: string[],
): Promise<BackfillApplyResult> {
  const result: BackfillApplyResult = { written: 0, skipped: 0, failed: [] };
  // A script has no tenant context: the locked row's tenant is the only source (appendWriteOffEvent rule (b)).
  const deps = { prisma: { getTenantId: () => null } };
  for (const invoiceId of invoiceIds) {
    try {
      const r = await db.$transaction((tx) => ensureWriteOffEvent(deps, tx, invoiceId));
      if (r.written) result.written += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed.push({ invoiceId, message: (err as Error).message });
    }
  }
  return result;
}
