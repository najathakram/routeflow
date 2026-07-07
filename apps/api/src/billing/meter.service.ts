import { Injectable, Logger } from "@nestjs/common";
import { MeterKey } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";

export interface MeterReading {
  meter: MeterKey;
  used: number;
  /** Included allotment; `null` means unlimited. */
  included: number | null;
  /** `null` when unlimited. */
  remaining: number | null;
  /** When the cycle meter resets; `null` for live meters (SEATS) / end-of-day (ROUTES). */
  resetsAt: Date | null;
}

interface Period {
  start: Date;
  end: Date;
}

/**
 * Usage metering for the four meters, with three distinct semantics:
 *  - SEATS  — live occupancy: a COUNT of active team users (never accumulated).
 *  - ROUTES — daily concurrency: a COUNT of today's route runs.
 *  - SCANS / MSGS — cycle counters bucketed by the billing period; a new period
 *    reads 0 automatically (bucketed by periodStart), so "reset" is implicit.
 *
 * {@link increment} NEVER throws and NEVER blocks — the spec requires that an
 * in-flight scan completes even past the cap; exceeding a cap only reports reduced
 * headroom for the upsell prompt.
 */
@Injectable()
export class MeterService {
  private readonly logger = new Logger(MeterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Read a meter's used / included / remaining / reset for the current cycle. */
  async read(tenantId: string, meter: MeterKey): Promise<MeterReading> {
    const ent = await this.entitlements.resolve(tenantId);
    const included = this.includedFor(ent.caps, meter);

    let used = 0;
    let resetsAt: Date | null = null;

    if (meter === "SEATS") {
      used = await this.seatsUsed(tenantId);
    } else if (meter === "ROUTES") {
      used = await this.routesToday(tenantId);
      resetsAt = this.endOfTodayUtc();
    } else {
      const period = await this.currentPeriod(tenantId);
      const row = await this.prisma.meterUsage.findUnique({
        where: { tenantId_meter_periodStart: { tenantId, meter, periodStart: period.start } },
        select: { used: true },
      });
      used = row?.used ?? 0;
      resetsAt = period.end;
    }

    const remaining = included == null ? null : Math.max(0, included - used);
    return { meter, used, included, remaining, resetsAt };
  }

  /** Read all four meters at once (for settings-billing usage bars). */
  async readAll(tenantId: string): Promise<MeterReading[]> {
    return Promise.all(
      (["SEATS", "ROUTES", "SCANS", "MSGS"] as MeterKey[]).map((m) => this.read(tenantId, m)),
    );
  }

  /**
   * Increment a cycle meter (SCANS / MSGS) by `n` for the current period.
   * Never throws — metering must never interrupt the metered action. SEATS/ROUTES
   * are live-counted and ignore increments.
   */
  async increment(tenantId: string, meter: MeterKey, n = 1): Promise<void> {
    if (meter === "SEATS" || meter === "ROUTES") return; // live meters are not accumulated
    // Metering is monotonic accumulation — a non-positive increment is a no-op
    // (never decrement, which would inflate reported remaining above the cap).
    if (!Number.isFinite(n) || n <= 0) return;
    const inc = Math.trunc(n);
    try {
      const period = await this.currentPeriod(tenantId);
      await this.prisma.meterUsage.upsert({
        where: { tenantId_meter_periodStart: { tenantId, meter, periodStart: period.start } },
        create: { tenantId, meter, periodStart: period.start, periodEnd: period.end, used: inc },
        update: { used: { increment: inc } },
      });
    } catch (err) {
      // Best-effort: metering failures must never surface to the metered flow.
      this.logger.error(`Failed to increment ${meter} for tenant ${tenantId}`, err as Error);
    }
  }

  /** Live seat occupancy: active (non-deactivated) team users. Buyers/super-admins excluded. */
  async seatsUsed(tenantId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        tenantId,
        deletedAt: null,
        status: "ACTIVE",
        role: { in: ["TENANT_ADMIN", "OPERATOR", "DRIVER"] },
      },
    });
  }

  /** Route runs scheduled for today (UTC) — the "concurrent routes / day" meter. */
  async routesToday(tenantId: string): Promise<number> {
    const start = this.startOfTodayUtc();
    const end = this.endOfTodayUtc();
    return this.prisma.routeRun.count({
      where: { tenantId, scheduledDate: { gte: start, lt: end } },
    });
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private includedFor(
    caps: {
      seats: number | null;
      routes: number | null;
      scans: number | null;
      msgs: number | null;
    },
    meter: MeterKey,
  ): number | null {
    switch (meter) {
      case "SEATS":
        return caps.seats;
      case "ROUTES":
        return caps.routes;
      case "SCANS":
        return caps.scans;
      case "MSGS":
        return caps.msgs;
    }
  }

  /**
   * The current billing-cycle bucket. Uses the subscription's period when it
   * covers now; otherwise falls back to the current calendar month (UTC) so
   * meters bucket deterministically before a first subscription exists.
   */
  private async currentPeriod(tenantId: string): Promise<Period> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { periodStart: true, periodEnd: true },
    });
    const now = new Date();
    if (sub?.periodStart && sub.periodEnd && sub.periodStart <= now && now < sub.periodEnd) {
      return { start: sub.periodStart, end: sub.periodEnd };
    }
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start, end };
  }

  private startOfTodayUtc(): Date {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }

  private endOfTodayUtc(): Date {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
  }
}
