import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<string | null> {
    const record = await this.prisma.systemConfig.findUnique({ where: { key } });
    return record?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.systemConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getAll(prefix: string): Promise<Record<string, string>> {
    const records = await this.prisma.systemConfig.findMany({
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
    if (dto.clientSecret !== undefined) updates.push(this.set("zoho.clientSecret", dto.clientSecret));
    if (dto.refreshToken !== undefined) updates.push(this.set("zoho.refreshToken", dto.refreshToken));
    if (dto.region !== undefined) updates.push(this.set("zoho.region", dto.region));
    await Promise.all(updates);
  }
}
