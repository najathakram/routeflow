import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

/**
 * Seller remit-to / how-to-pay info shown to buyers (P5-14). Stored as ONE JSON
 * document under `remittance.config` (no migration). Buyer-visible BY DESIGN —
 * the seller's own remit-to info, same data printed on an invoice — so it is
 * intentionally NOT in SECRET_KEYS.
 */
export const REMITTANCE_FIELDS = [
  "payToName",
  "bankName",
  "accountName",
  "accountNumber",
  "routingNumber",
  "achInstructions",
  "wireInstructions",
  "checkInstructions",
  "mailingAddress",
  "notes",
] as const;
export type RemittanceField = (typeof REMITTANCE_FIELDS)[number];
export type RemittanceConfig = Partial<Record<RemittanceField, string>>;

@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  /**
   * Secret-valued keys (security F5-004): encrypted at rest via EncryptionService,
   * mirroring the TenantConfig SMTP/OAuth path. Everything else stays plaintext.
   */
  private static readonly SECRET_KEYS = new Set([
    "email.smtpPassword",
    "anthropic.apiKey",
    "zoho.clientSecret",
    "zoho.refreshToken",
  ]);
  /** AES-256-GCM storage shape from EncryptionService: IV_HEX:TAG_HEX:CIPHERTEXT_B64. */
  private static readonly ENCRYPTED_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private isSecretKey(key: string): boolean {
    return SystemConfigService.SECRET_KEYS.has(key);
  }

  private encryptIfSecret(key: string, value: string): string {
    // Only encrypt non-empty secrets — an empty string is the "cleared" sentinel.
    return value && this.isSecretKey(key) ? this.encryption.encrypt(value) : value;
  }

  private decryptIfSecret(key: string, value: string | null): string | null {
    if (!value || !this.isSecretKey(key)) return value;
    // Legacy rows written before F5-004 are plaintext (don't match the cipher shape)
    // — pass them through so existing SMTP/API keys keep working until re-saved.
    if (!SystemConfigService.ENCRYPTED_FORMAT.test(value)) return value;
    try {
      return this.encryption.decrypt(value);
    } catch {
      this.logger.error(`Failed to decrypt SystemConfig secret "${key}"`);
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    // findFirst instead of findUnique because the unique constraint is now
    // composite (tenantId, key) and forTenant() injects tenantId at runtime.
    const record = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    return this.decryptIfSecret(key, record?.value ?? null);
  }

  async set(key: string, value: string): Promise<void> {
    const toStore = this.encryptIfSecret(key, value);
    // Use findFirst + create/update instead of upsert because upsert requires
    // a composite unique key (tenantId_key) that the forTenant() extension
    // cannot auto-inject into the `where` clause.
    const existing = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    if (existing) {
      await this.prisma
        .forTenant()
        .systemConfig.update({ where: { id: existing.id }, data: { value: toStore } });
    } else {
      // tenantId is injected automatically by forTenant() at runtime
      await (this.prisma.forTenant().systemConfig.create as any)({ data: { key, value: toStore } });
    }
  }

  async getAll(prefix: string): Promise<Record<string, string>> {
    const records = await this.prisma.forTenant().systemConfig.findMany({
      where: { key: { startsWith: prefix } },
    });
    return Object.fromEntries(
      records.map((r) => [r.key, this.decryptIfSecret(r.key, r.value) ?? ""]),
    );
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

  // ─── Remittance / how-to-pay config (P5-14) ─────────────────────────────────
  // ONE JSON blob under `remittance.config`. PATCH semantics: undefined =
  // untouched, "" = cleared. Reads/writes via get()/set() (tenant scoped).
  private static readonly REMITTANCE_KEY = "remittance.config";

  async getRemittanceConfig(): Promise<RemittanceConfig> {
    const raw = await this.get(SystemConfigService.REMITTANCE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: RemittanceConfig = {};
      for (const field of REMITTANCE_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string" && value.length > 0) out[field] = value;
      }
      return out;
    } catch {
      this.logger.error("Corrupt remittance.config JSON — returning empty config");
      return {};
    }
  }

  async setRemittanceConfig(dto: RemittanceConfig): Promise<void> {
    const current = await this.getRemittanceConfig();
    const next: RemittanceConfig = { ...current };
    for (const field of REMITTANCE_FIELDS) {
      const value = dto[field];
      if (value === undefined) continue;
      if (value === "") delete next[field];
      else next[field] = value;
    }
    await this.set(SystemConfigService.REMITTANCE_KEY, JSON.stringify(next));
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
