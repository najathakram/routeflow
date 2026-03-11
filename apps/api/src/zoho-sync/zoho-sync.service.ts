import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";

interface ZohoTokenResponse {
  access_token: string;
}

interface ZohoItem {
  item_id: string;
  name: string;
  description?: string;
  rate: number;
  stock_on_hand?: number;
  unit?: string;
  category_name?: string;
  sku?: string;
}

interface ZohoItemsResponse {
  items: ZohoItem[];
  page_context?: { has_more_page: boolean; page: number };
}

@Injectable()
export class ZohoSyncService {
  private readonly logger = new Logger(ZohoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SystemConfigService,
  ) {}

  private getBaseUrl(region: string): string {
    if (region === "eu") return "https://www.zohoapis.eu";
    if (region === "in") return "https://www.zohoapis.in";
    if (region === "au") return "https://www.zohoapis.com.au";
    return "https://www.zohoapis.com";
  }

  private getAccountsBaseUrl(region: string): string {
    if (region === "eu") return "https://accounts.zoho.eu";
    if (region === "in") return "https://accounts.zoho.in";
    if (region === "au") return "https://accounts.zoho.com.au";
    return "https://accounts.zoho.com";
  }

  private async getAccessToken(cfg: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    region: string;
  }): Promise<string> {
    const tokenUrl = `${this.getAccountsBaseUrl(cfg.region)}/oauth/v2/token`;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
    });

    const response = await axios.post<ZohoTokenResponse>(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    return response.data.access_token;
  }

  async syncProducts(): Promise<{ synced: number; created: number; updated: number }> {
    const zohoConfig = await this.config.getZohoConfig();

    if (!zohoConfig.clientId || !zohoConfig.clientSecret || !zohoConfig.refreshToken) {
      throw new BadRequestException(
        "Zoho not configured. Please set credentials in Settings.",
      );
    }

    const accessToken = await this.getAccessToken({
      clientId: zohoConfig.clientId,
      clientSecret: zohoConfig.clientSecret,
      refreshToken: zohoConfig.refreshToken,
      region: zohoConfig.region,
    });

    const baseUrl = this.getBaseUrl(zohoConfig.region);
    let page = 1;
    let hasMore = true;
    let created = 0;
    let updated = 0;

    while (hasMore) {
      const response = await axios.get<ZohoItemsResponse>(`${baseUrl}/inventory/v1/items`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: { page, per_page: 200 },
      });

      const items = response.data.items ?? [];
      hasMore = response.data.page_context?.has_more_page ?? false;
      page++;

      for (const item of items) {
        try {
          const existing = await this.prisma.product.findUnique({
            where: { zohoProductId: item.item_id },
          });

          const stockQty = item.stock_on_hand ?? 0;
          const lowStockThreshold = 5;

          const productData = {
            name: item.name,
            description: item.description ?? null,
            unit: item.unit ?? "unit",
            pricePerUnit: item.rate ?? 0,
            category: item.category_name ?? null,
            sku: item.sku || null,
            zohoProductId: item.item_id,
            lowStock: stockQty <= lowStockThreshold,
          };

          if (existing) {
            if (!existing.hasLocalOverride) {
              await this.prisma.product.update({
                where: { id: existing.id },
                data: productData,
              });
            }
            updated++;
          } else {
            // Omit sku if it would collide with an existing product
            const createData = item.sku
              ? productData
              : { ...productData, sku: null };
            await this.prisma.product.create({ data: createData });
            created++;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Skipping Zoho item ${item.item_id} (${item.name}): ${msg}`);
        }
      }

      if (items.length === 0) break;
    }

    const synced = created + updated;
    await this.config.set("zoho.lastSync", new Date().toISOString());
    this.logger.log(`Zoho sync complete: ${synced} products (${created} created, ${updated} updated)`);

    return { synced, created, updated };
  }

  async getStatus(): Promise<{ configured: boolean; lastSync: string | null }> {
    const zohoConfig = await this.config.getZohoConfig();
    const configured = !!(zohoConfig.clientId && zohoConfig.clientSecret && zohoConfig.refreshToken);
    return { configured, lastSync: zohoConfig.lastSync };
  }

  async getConfig(): Promise<{
    clientId: string | null;
    region: string;
    hasClientSecret: boolean;
    hasRefreshToken: boolean;
  }> {
    const cfg = await this.config.getZohoConfig();
    return {
      clientId: cfg.clientId,
      region: cfg.region,
      hasClientSecret: !!cfg.clientSecret,
      hasRefreshToken: !!cfg.refreshToken,
    };
  }

  async updateConfig(dto: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    region?: string;
  }): Promise<{ message: string }> {
    await this.config.setZohoConfig(dto);
    return { message: "Zoho configuration saved." };
  }
}
