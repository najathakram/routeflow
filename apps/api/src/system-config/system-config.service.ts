import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<string | null> {
    // findFirst instead of findUnique because the unique constraint is now
    // composite (tenantId, key) and forTenant() injects tenantId at runtime.
    const record = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    return record?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    // Use findFirst + create/update instead of upsert because upsert requires
    // a composite unique key (tenantId_key) that the forTenant() extension
    // cannot auto-inject into the `where` clause.
    const existing = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    if (existing) {
      await this.prisma
        .forTenant()
        .systemConfig.update({ where: { id: existing.id }, data: { value } });
    } else {
      // tenantId is injected automatically by forTenant() at runtime
      await (this.prisma.forTenant().systemConfig.create as any)({ data: { key, value } });
    }
  }

  async getAll(prefix: string): Promise<Record<string, string>> {
    const records = await this.prisma.forTenant().systemConfig.findMany({
      where: { key: { startsWith: prefix } },
    });
    return Object.fromEntries(records.map((r) => [r.key, r.value]));
  }

  async getZohoConfig(): Promise<{
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    region: string;
    lastSync: string | null;
  }> {
    const all = await this.getAll("zoho.");
    return {
      clientId: all["zoho.clientId"] ?? process.env.ZOHO_CLIENT_ID ?? null,
      clientSecret: all["zoho.clientSecret"] ?? process.env.ZOHO_CLIENT_SECRET ?? null,
      refreshToken: all["zoho.refreshToken"] ?? process.env.ZOHO_REFRESH_TOKEN ?? null,
      region: all["zoho.region"] ?? process.env.ZOHO_REGION ?? "com",
      lastSync: all["zoho.lastSync"] ?? null,
    };
  }

  async setZohoConfig(dto: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    region?: string;
  }): Promise<void> {
    const updates: Promise<void>[] = [];
    if (dto.clientId !== undefined) updates.push(this.set("zoho.clientId", dto.clientId));
    if (dto.clientSecret !== undefined)
      updates.push(this.set("zoho.clientSecret", dto.clientSecret));
    if (dto.refreshToken !== undefined)
      updates.push(this.set("zoho.refreshToken", dto.refreshToken));
    if (dto.region !== undefined) updates.push(this.set("zoho.region", dto.region));
    await Promise.all(updates);
  }
}
