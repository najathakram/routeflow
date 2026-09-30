import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { filingPeriod, FilingCadence } from "./period";

/**
 * The most-recently-CLOSED filing period for a cadence relative to `now`, as the
 * `{year, index}` pair `filingPeriod`/`prepareFiling` expect. All math is UTC to
 * match period.ts (which buckets ledger rows in UTC). The tricky bit is the January
 * rollover: in January the previous month is December of the prior year, Q1 rolls
 * back to Q4 of the prior year, and ANNUAL always steps to the prior calendar year.
 *
 * MONTHLY  → previous calendar month (index = 1-12).
 * QUARTERLY→ previous quarter (index = 1-4).
 * ANNUAL   → previous calendar year (index unused; returned as 1).
 */
export function previousClosedPeriod(
  cadence: FilingCadence,
  now: Date,
): { year: number; index: number } {
  const y = now.getUTCFullYear();

  if (cadence === "QUARTERLY") {
    // Absolute quarter index, then step back one — floor division handles the
    // Q1 → Q4-prior-year rollover without any special-casing.
    const currentQuarter = Math.floor(now.getUTCMonth() / 3); // 0-3
    const prev = y * 4 + currentQuarter - 1;
    return { year: Math.floor(prev / 4), index: (prev % 4) + 1 };
  }

  if (cadence === "ANNUAL") {
    return { year: y - 1, index: 1 };
  }

  // MONTHLY — absolute month index, step back one (Jan → Dec-prior-year).
  const prev = y * 12 + now.getUTCMonth() - 1;
  return { year: Math.floor(prev / 12), index: (prev % 12) + 1 };
}

/**
 * RF-5: auto-prepares regulated filings once a filing period closes. `prepareFiling`
 * is otherwise manual (POST-only); this daily cron sweeps every tenant's active
 * TrackedCategories and prepares the most-recently-closed period for each — skipping
 * any that already exist so it is idempotent across runs.
 */
@Injectable()
export class RegulatedFilingCronService {
  private readonly logger = new Logger(RegulatedFilingCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly filing: RegulatedFilingService,
  ) {}

  /**
   * Daily at 04:00 UTC — offset from the tobacco (02:00) and auth-expiry (03:00)
   * crons so they don't pile onto the same tick.
   */
  @LeaderCron("0 4 * * *", "regulated-filing.autoPrepareClosedFilings")
  async autoPrepareClosedFilings(): Promise<void> {
    const now = new Date();
    // System-level (NO forTenant) → every tenant's active categories; each row
    // carries its own tenantId, which we set as context per prepare. Compliance
    // pack: only tenants with the active tobacco_dealer addon get auto-prepared
    // filings (mirrors the tobacco report cron's addon intersection).
    const [categories, packAddons] = await Promise.all([
      this.prisma.trackedCategory.findMany({
        where: { active: true },
        select: { id: true, tenantId: true, reportCadence: true },
      }),
      this.prisma.tenantAddon.findMany({
        where: { addonKey: "tobacco_dealer", active: true },
        select: { tenantId: true },
      }),
    ]);
    const packTenants = new Set(packAddons.map((a) => a.tenantId));
    const gated = categories.filter((c) => packTenants.has(c.tenantId));

    let prepared = 0;
    let skipped = 0;
    for (const cat of gated) {
      const cadence = cat.reportCadence as FilingCadence;
      const { year, index } = previousClosedPeriod(cadence, now);
      const { periodKey } = filingPeriod(cadence, year, index);
      // Wrap EACH tenant in its own context + try/catch so one tenant's failure
      // (or a mid-period edge) never aborts the batch (mirrors billing-cron).
      try {
        const done = await this.tenantCtx.run(cat.tenantId, async () => {
          const existing = await this.prisma.forTenant().regulatedFiling.findFirst({
            where: { trackedCategoryId: cat.id, periodKey },
            select: { id: true },
          });
          if (existing) return false; // idempotent: already prepared
          await this.filing.prepareFiling({
            trackedCategoryId: cat.id,
            year,
            index,
            userId: null, // system/cron trigger
          });
          return true;
        });
        if (done) prepared++;
        else skipped++;
      } catch (err) {
        this.logger.warn(
          `Auto-prepare failed for category ${cat.id} (tenant ${cat.tenantId}) ` +
            `${cadence} ${periodKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (prepared || skipped) {
      this.logger.log(
        `Regulated filing auto-prepare: ${prepared} prepared, ${skipped} already present ` +
          `(${gated.length} of ${categories.length} active categories on pack tenants)`,
      );
    }
  }
}
