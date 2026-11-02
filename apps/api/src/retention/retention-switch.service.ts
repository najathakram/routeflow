import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** SA-1083: one `PlatformConfig` switch per retention job. Nothing writes these keys yet: a flip is its own change. */
export const RETENTION_LOCATION_SWITCH = "retention.driverLocationsEnforced";
export const RETENTION_DEMO_BOOKING_SWITCH = "retention.demoBookingsEnforced";

/** `report` runs the job's real plan and deletes nothing. */
export type RetentionMode = "report" | "enforce";

/** Enforce only on a stored `{ "enforced": true }`. A missing, empty or unreadable value, or anything else, reports. */
export function parseRetentionSwitch(raw: string | null | undefined): RetentionMode {
  if (raw == null) return "report";
  try {
    const v: unknown = JSON.parse(raw.trim());
    return v && typeof v === "object" && (v as { enforced?: unknown }).enforced === true
      ? "enforce"
      : "report";
  } catch {
    return "report";
  }
}

/** Read once per run, never cached. A database that can't answer is never the reason a row is deleted. */
@Injectable()
export class RetentionSwitchService {
  private readonly logger = new Logger(RetentionSwitchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async modeOf(key: string): Promise<RetentionMode> {
    try {
      const rows = await this.prisma.$queryRaw<{ value: string }[]>`
        SELECT value FROM "PlatformConfig" WHERE key = ${key} LIMIT 1
      `;
      return parseRetentionSwitch(rows[0]?.value);
    } catch (err) {
      this.logger.error(`Failed to read ${key}: running report-only`, err as Error);
      return "report";
    }
  }
}
