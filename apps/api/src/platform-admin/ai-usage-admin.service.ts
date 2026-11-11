import { BadRequestException, Injectable } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import {
  effectiveCapUsd,
  estimateSpendUsd,
  PlatformConfigService,
  utcMonthStart,
} from "./platform-config.service";

const WHOLE_PERCENT = 100;

export interface AiUsageByBusinessRow {
  tenantId: string;
  name: string;
  calls: number;
  /** Estimated spend this month on RouteFlow's key, in USD (every usage row counts, as the cap check does). */
  spendUsd: number;
  /** The allowance that applies: 0 = AI off for this business. */
  capUsd: number;
  /** spend / cap as a whole percent; null when AI is off (cap 0). */
  percentUsed: number | null;
  aiOff: boolean;
}

export interface AiUsageByBusiness {
  /** `YYYY-MM`, UTC. */
  month: string;
  platformCapUsd: number;
  businesses: AiUsageByBusinessRow[];
}

/** `YYYY-MM` (UTC) to its first instant and the next month's; a missing value is the month `now` falls in. */
export function parseUsageMonth(raw: string | undefined, now: Date) {
  const m = raw === undefined || raw === "" ? null : /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw);
  if (raw !== undefined && raw !== "" && !m)
    throw new BadRequestException("month must look like 2026-11");
  const start = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : utcMonthStart(now);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label };
}

interface SpendRow {
  tenantId: string;
  model: string;
  inTok: number;
  outTok: number;
  calls: number;
}

@Injectable()
export class AiUsageAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  /** Every business's spend for one UTC month beside the allowance that applies to it, largest spend first. */
  async byBusiness(month?: string): Promise<AiUsageByBusiness> {
    const { start, end, label } = parseUsageMonth(month, new Date());
    const platformCapUsd = await this.platformConfig.platformMonthlyCapUsd();
    const rows = await this.prisma.$queryRaw<SpendRow[]>`
      SELECT "tenantId", "model",
             COUNT(*)::int AS "calls",
             COALESCE(SUM("inputTokens"), 0)::float8 AS "inTok",
             COALESCE(SUM("outputTokens"), 0)::float8 AS "outTok"
      FROM "AiUsageEvent"
      WHERE "tenantId" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY "tenantId", "model"
    `;
    const perTenant = new Map<string, { spend: number; calls: number }>();
    for (const r of rows) {
      const cur = perTenant.get(r.tenantId) ?? { spend: 0, calls: 0 };
      cur.spend += estimateSpendUsd([r]);
      cur.calls += Number(r.calls);
      perTenant.set(r.tenantId, cur);
    }
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, aiMonthlyCapUsd: true },
    });
    const businesses = tenants
      .map((t): AiUsageByBusinessRow => {
        const used = perTenant.get(t.id) ?? { spend: 0, calls: 0 };
        const capUsd = effectiveCapUsd(platformCapUsd, t.aiMonthlyCapUsd);
        return {
          tenantId: t.id,
          name: t.name,
          calls: used.calls,
          spendUsd: roundMoney(used.spend),
          capUsd,
          percentUsed: capUsd > 0 ? Math.round((used.spend * WHOLE_PERCENT) / capUsd) : null,
          aiOff: capUsd === 0,
        };
      })
      .sort((a, b) => b.spendUsd - a.spendUsd || a.name.localeCompare(b.name));
    return { month: label, platformCapUsd, businesses };
  }
}
