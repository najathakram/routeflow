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

  // ─── Cost / margin config (pos-cost-roles-spec §1) ─────────────────────────
  // Stored in the SystemConfig key-value store (no migration): `costing.method`,
  // `margin.floor.default`, `margin.floor.category.<category>`. Floors are
  // fractions (0.15 = 15%). Writes are TENANT_ADMIN-gated at the controller.

  async getMarginConfig(): Promise<{
    costingMethod: "WEIGHTED_AVERAGE" | "FIFO" | "LAST_COST";
    defaultMarginFloor: number;
    categoryFloors: Record<string, number>;
  }> {
    const all = await this.getAll("margin.floor.");
    const method = await this.get("costing.method");
    const categoryFloors: Record<string, number> = {};
    for (const [key, value] of Object.entries(all)) {
      const match = key.match(/^margin\.floor\.category\.(.+)$/);
      if (!match) continue;
      const n = Number(value);
      if (Number.isFinite(n)) categoryFloors[match[1]] = n;
    }
    const def = Number(all["margin.floor.default"]);
    const validMethod =
      method === "FIFO" || method === "LAST_COST" || method === "WEIGHTED_AVERAGE"
        ? method
        : "WEIGHTED_AVERAGE";
    return {
      costingMethod: validMethod,
      defaultMarginFloor: Number.isFinite(def) ? def : 0.15, // 15% default floor
      categoryFloors,
    };
  }

  async setMarginConfig(dto: {
    costingMethod?: string;
    defaultMarginFloor?: number;
    categoryFloors?: Record<string, number>;
  }): Promise<void> {
    const updates: Promise<void>[] = [];
    if (dto.costingMethod !== undefined)
      updates.push(this.set("costing.method", dto.costingMethod));
    if (dto.defaultMarginFloor !== undefined)
      updates.push(this.set("margin.floor.default", String(dto.defaultMarginFloor)));
    if (dto.categoryFloors) {
      for (const [category, floor] of Object.entries(dto.categoryFloors)) {
        updates.push(this.set(`margin.floor.category.${category}`, String(floor)));
      }
    }
    await Promise.all(updates);
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
