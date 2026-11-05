import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { decryptIfSecret, encryptIfSecret } from "../common/secret-at-rest";
import { assertCostingMethodAllowed } from "../inventory/costing-method-policy";

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

/**
 * Secret-valued keys (security F5-004): encrypted at rest via EncryptionService,
 * mirroring the TenantConfig SMTP/OAuth path. Everything else stays plaintext.
 * Exported so the boot report and the secret-keys pin read the one list.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "email.smtpPassword",
  "anthropic.apiKey",
  "zoho.clientSecret",
  "zoho.refreshToken",
]);

/** Keys already warned about for a tenantless read (once per key per process, so a hot path cannot flood the log). */
const WARNED_TENANTLESS_READS = new Set<string>();

@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * SA-1102 2.2 + A-1(b): `prisma.forTenant()` is the UNSCOPED client when no tenant is in context, so a tenantless
   * read returns ANY business's row (for `anthropic.apiKey`: another business's key) and a tenantless write overwrites
   * one. A SECRET read and EVERY write refuse first with a coded 500 and the key name in the log, and run no query. It
   * does not return null: a null `settings.taxRate` would silently become tax 0, so a loud failure is the safe one.
   * Other reads still work (a SUPER_ADMIN with no business reaches about 20 of them) and warn once per key per process.
   */
  private refuse(op: string, key: string): never {
    this.logger.error(`SystemConfigService.${op}("${key}") ran with no business in context`);
    throw new InternalServerErrorException({
      code: API_ERROR_CODES.SYSTEM_CONFIG_TENANT_REQUIRED,
      message: "Settings were read without a business. This is a RouteFlow bug.",
    });
  }

  private guardRead(op: string, key: string, touchesSecret: boolean): void {
    if (this.prisma.getTenantId()) return;
    if (touchesSecret) this.refuse(op, key);
    if (!WARNED_TENANTLESS_READS.has(key)) {
      WARNED_TENANTLESS_READS.add(key);
      this.logger.warn(`SystemConfig read without a business: ${key}`);
    }
  }

  private decrypt(key: string, value: string | null): string | null {
    return decryptIfSecret(SECRET_KEYS, this.encryption, key, value, () =>
      this.logger.error(`Failed to decrypt SystemConfig secret "${key}"`),
    );
  }

  async get(key: string): Promise<string | null> {
    this.guardRead("get", key, SECRET_KEYS.has(key));
    // findFirst instead of findUnique because the unique constraint is now
    // composite (tenantId, key) and forTenant() injects tenantId at runtime.
    const record = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    return this.decrypt(key, record?.value ?? null);
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.prisma.getTenantId()) this.refuse("set", key);
    const toStore = encryptIfSecret(SECRET_KEYS, this.encryption, key, value);
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
    this.guardRead(
      "getAll",
      prefix,
      [...SECRET_KEYS].some((k) => k.startsWith(prefix)),
    );
    const records = await this.prisma.forTenant().systemConfig.findMany({
      where: { key: { startsWith: prefix } },
    });
    return Object.fromEntries(records.map((r) => [r.key, this.decrypt(r.key, r.value) ?? ""]));
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
    costingMethod: "WEIGHTED_AVERAGE" | "LAST_COST";
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
    // SA-804 (1): a stored FIFO (retired) reads as WEIGHTED_AVERAGE, the average cost it is costed by.
    const validMethod = method === "LAST_COST" ? "LAST_COST" : "WEIGHTED_AVERAGE";
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
    // SA-804 (1) / B1232: FIFO and LIFO are retired: refuse SETTING one (400 COSTING_METHOD_RETIRED) before ANY key
    // is written; re-sending the stored value is a no-op, not a set.
    if (dto.costingMethod !== undefined) {
      assertCostingMethodAllowed(dto.costingMethod, await this.get("costing.method"));
    }
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

  // ─── Pricing tier labels (rung-2 config) ────────────────────────────────────
  // Tenant-configurable display names for price tiers 1-5 (e.g. "Wholesaler"
  // instead of "Tier 2"). ONE JSON blob under `pricing.tierLabels`, keyed by
  // tier number as a string ("1".."5"). PATCH semantics match remittance:
  // undefined = untouched, "" = cleared (falls back to "Tier N" at render
  // time via the tierLabel() helper in common/tier-label.ts).
  private static readonly TIER_LABELS_KEY = "pricing.tierLabels";
  private static readonly TIER_LABEL_KEYS = ["1", "2", "3", "4", "5"] as const;

  async getPricingTierLabels(): Promise<Record<string, string>> {
    const raw = await this.get(SystemConfigService.TIER_LABELS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const key of SystemConfigService.TIER_LABEL_KEYS) {
        const value = parsed[key];
        if (typeof value === "string" && value.length > 0) out[key] = value;
      }
      return out;
    } catch {
      this.logger.error("Corrupt pricing.tierLabels JSON — returning empty config");
      return {};
    }
  }

  async setPricingTierLabels(dto: {
    tier1?: string;
    tier2?: string;
    tier3?: string;
    tier4?: string;
    tier5?: string;
  }): Promise<void> {
    const current = await this.getPricingTierLabels();
    const next: Record<string, string> = { ...current };
    const pairs: Array<[string, string | undefined]> = [
      ["1", dto.tier1],
      ["2", dto.tier2],
      ["3", dto.tier3],
      ["4", dto.tier4],
      ["5", dto.tier5],
    ];
    for (const [key, value] of pairs) {
      if (value === undefined) continue;
      if (value === "") delete next[key];
      else next[key] = value;
    }
    await this.set(SystemConfigService.TIER_LABELS_KEY, JSON.stringify(next));
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
