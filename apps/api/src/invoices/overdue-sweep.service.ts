import { Injectable, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { LeaderCron } from "../common/cron-lock";
import { overdueCutoff } from "../common/calendar-date";
import { resolveZone } from "../common/tenant-time-zone";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

/**
 * SA-506a (#2556, owner policy): the sweep shipped DARK; the owner turned it ON on 2026-10-10
 * (read-only count first: 16 live past-due invoices across 2 tenants; "overdue flag only", the
 * flip is the ONLY effect). One env var.
 *   off       the sweep runs NO query; it logs one line that it is off.
 *   dark      (emergency dark-back: set OVERDUE_SWEEP_MODE=dark) COUNT the rows the sweep would flip, with the SAME per-tenant where,
 *             and log ONE line per run: the aggregate plus per-tenant counts keyed by tenant id
 *             (never a slug or name). Nothing is written.
 *   enforced  write the flip. Turning it on is an OWNER action, after the read-only count
 *             (apps/api/scripts/report-2520-first-overdue-sweep.mjs): the first run flips the
 *             whole past-due backlog at once.
 * Any other value → dark, with a warning (fail closed toward no writes).
 */
export const OVERDUE_SWEEP_ENV = "OVERDUE_SWEEP_MODE";
export const OVERDUE_SWEEP_MODES = ["off", "dark", "enforced"] as const;
export type OverdueSweepMode = (typeof OVERDUE_SWEEP_MODES)[number];
/** The mode when the variable is UNSET (owner 2026-10-10). */
export const OVERDUE_SWEEP_DEFAULT: OverdueSweepMode = "enforced";
/** The mode for a set-but-unrecognised value: never writes. */
export const OVERDUE_SWEEP_FAIL_CLOSED: OverdueSweepMode = "dark";

/** The mode, and whether the raw value was unrecognised (the caller warns). */
export function overdueSweepMode(env: NodeJS.ProcessEnv = process.env): {
  mode: OverdueSweepMode;
  unknown: string | null;
} {
  const raw = env[OVERDUE_SWEEP_ENV];
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if ((OVERDUE_SWEEP_MODES as readonly string[]).includes(v))
    return { mode: v as OverdueSweepMode, unknown: null };
  // #2567: only an UNSET variable is the silent default; a set-but-blank value warns like any
  // other unrecognised one, and fails closed (dark) rather than taking the enforced default.
  if (raw === undefined) return { mode: OVERDUE_SWEEP_DEFAULT, unknown: null };
  return { mode: OVERDUE_SWEEP_FAIL_CLOSED, unknown: String(raw) };
}

/** The tenant statuses whose open invoices are aged (billing-live tenants only). */
const SWEPT_TENANT_STATUSES = ["TRIAL", "ACTIVE"] as const;

/**
 * The invoice statuses the sweep may flip: issued and UNPAID only. PARTIAL is deliberately absent
 * (#2556 B2): `recomputeInvoiceStatus` keeps a part-paid invoice PARTIAL, so flipping it here
 * would flip-flop on every payment and move it into sets that exclude PARTIAL on purpose (the
 * order-edit revert set, bookkeeping's "UNPAID" filter).
 */
export const SWEPT_INVOICE_STATUSES = [InvoiceStatus.SENT, InvoiceStatus.VIEWED] as const;

/**
 * #2520 (SA-495a): flip issued, unpaid invoices to OVERDUE once their due day has ENDED in THEIR
 * tenant's zone (SA-488's `overdueCutoff`, UTC when the tenant has none).
 *
 * This used to be `InvoicesService.markOverdue()`: dead code, never scheduled, and a bare-cron
 * caller would have run it unscoped on the UTC day. It now runs HOURLY under `@LeaderCron` (one
 * replica), so every tenant is evaluated within the hour after ITS local midnight. Each tenant is
 * swept with an explicit `tenantId` filter inside that tenant's context; one tenant failing never
 * stops the others. It shipped in the same PR as the required `timeZone` on every status writer.
 */
@Injectable()
export class OverdueSweepService {
  private readonly logger = new Logger(OverdueSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Hourly, one replica. Enforced unless OVERDUE_SWEEP_MODE says dark (count only) or off (no query). */
  @LeaderCron("5 * * * *", "invoices.markOverdue")
  async runScheduled(): Promise<void> {
    const { mode, unknown } = overdueSweepMode();
    if (unknown !== null)
      this.logger.warn(
        `${OVERDUE_SWEEP_ENV}="${unknown}" is not off|dark|enforced; running dark (nothing written)`,
      );
    if (mode === "off") {
      this.logger.log(`markOverdue [off]: ${OVERDUE_SWEEP_ENV}=off, the sweep ran no query`);
      return;
    }
    await this.markOverdue(new Date(), mode);
  }

  async markOverdue(
    now: Date = new Date(),
    mode: Exclude<OverdueSweepMode, "off"> = "dark",
  ): Promise<{ mode: OverdueSweepMode; tenants: number; rows: number; failed: number }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: [...SWEPT_TENANT_STATUSES] } },
      select: { id: true },
    });
    const dryRun = mode !== "enforced";
    let rows = 0;
    let failed = 0;
    const perTenant: string[] = [];
    for (const tenant of tenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        try {
          const n = await markOverdueForTenant(this.prisma, tenant.id, now, { dryRun });
          rows += n;
          if (n > 0) perTenant.push(`${tenant.id}=${n}`);
        } catch (err) {
          failed++;
          this.logger.error(
            `markOverdue failed for tenant ${tenant.id}: ${(err as Error)?.message}`,
          );
        }
      });
    }
    if (rows > 0 || failed > 0 || dryRun)
      this.logger.log(
        `markOverdue [${mode}]: ${rows} invoice(s) ${dryRun ? "WOULD flip (nothing written)" : "flipped"} across ${tenants.length} tenant(s), ${failed} failed${perTenant.length ? `; per tenant ${perTenant.join(", ")}` : ""}`,
      );
    return { mode, tenants: tenants.length, rows, failed };
  }
}

/**
 * One tenant's sweep: its own zone's day, an explicit tenant filter (never the ambient one).
 * Fails closed without a tenant. `dryRun` COUNTS with the same where and writes nothing.
 */
export async function markOverdueForTenant(
  prisma: Pick<PrismaService, "tenantConfig" | "invoice">,
  tenantId: string,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<number> {
  if (!tenantId) throw new Error("markOverdue needs a tenant id (never an unscoped sweep)");
  const { zone } = await resolveZone(prisma, { tenantId });
  const where = {
    tenantId,
    status: { in: [...SWEPT_INVOICE_STATUSES] },
    dueDate: { lt: overdueCutoff(now, zone) },
  };
  if (opts.dryRun) return prisma.invoice.count({ where });
  const res = await prisma.invoice.updateMany({ where, data: { status: InvoiceStatus.OVERDUE } });
  return res.count;
}
