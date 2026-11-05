import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ENCRYPTED_FORMAT } from "../common/secret-at-rest";
import { PLATFORM_SECRET_KEYS } from "../platform-admin/platform-config.service";
import { SECRET_KEYS } from "./system-config.service";

export interface PlaintextSecretCounts {
  systemConfig: Record<string, number>;
  platformConfig: Record<string, number>;
}

/**
 * SA-1102 2.5: a read-only boot report of secret rows still stored as plaintext (a legacy row written before the
 * secret was encrypted). Keys and counts only: no value, no tenant id. It lives here, not in `main.ts`, which stays
 * DDL- and query-free (PR-1 imp-03a). The classification runs in the database (`value !~ <cipher shape>`), so no secret
 * value is read into the process. It never throws and never blocks boot: a failed count is a WARN.
 * `apps/api/scripts/report-plaintext-secrets.mjs` runs the same count from the command line.
 */
@Injectable()
export class PlaintextSecretsReport implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlaintextSecretsReport.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Fire and forget: a slow or unreachable database must not hold up boot. `run` never rejects.
    void this.run();
  }

  async counts(): Promise<PlaintextSecretCounts> {
    const pattern = ENCRYPTED_FORMAT.source;
    const systemKeys = [...SECRET_KEYS];
    const platformKeys = [...PLATFORM_SECRET_KEYS];
    const sys = await this.prisma.$queryRaw<{ key: string; n: number }[]>`
      SELECT "key", COUNT(*)::int AS n FROM "SystemConfig"
      WHERE "key" = ANY(${systemKeys}::text[]) AND "value" <> '' AND "value" !~ ${pattern}
      GROUP BY "key"`;
    const plat = await this.prisma.$queryRaw<{ key: string; n: number }[]>`
      SELECT "key", COUNT(*)::int AS n FROM "PlatformConfig"
      WHERE "key" = ANY(${platformKeys}::text[]) AND "value" <> '' AND "value" !~ ${pattern}
      GROUP BY "key"`;
    const toMap = (rows: { key: string; n: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
    return { systemConfig: toMap(sys), platformConfig: toMap(plat) };
  }

  async run(): Promise<void> {
    try {
      const c = await this.counts();
      const fmt = (m: Record<string, number>) =>
        `{${Object.keys(m)
          .sort()
          .map((k) => `${k}: ${m[k]}`)
          .join(", ")}}`;
      if (Object.keys(c.systemConfig).length > 0 || Object.keys(c.platformConfig).length > 0) {
        this.logger.error(
          `plaintext secrets at rest: SystemConfig ${fmt(c.systemConfig)}; PlatformConfig ${fmt(c.platformConfig)}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `plaintext secrets check failed (boot continues): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
