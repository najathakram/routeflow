import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

const CLAUDE_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
];

@Injectable()
export class PlatformConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Auto-create the PlatformConfig table if it doesn't exist yet.
   * This avoids needing a manual migration when the feature is first deployed.
   */
  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "PlatformConfig" (
          "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
          "key"       TEXT NOT NULL,
          "value"     TEXT NOT NULL,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
          CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "PlatformConfig_key_key" UNIQUE ("key")
        )
      `;
      this.logger.log("PlatformConfig table ready");
    } catch (err: any) {
      this.logger.error(`PlatformConfig table setup failed: ${err?.message}`);
    }
  }

  // ─── Low-level helpers ──────────────────────────────────────────────────────

  private async getValue(key: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "PlatformConfig" WHERE key = ${key} LIMIT 1
    `;
    return rows[0]?.value ?? null;
  }

  private async setValue(key: string, value: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, ${key}, ${value}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;
  }

  private async deleteValue(key: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "PlatformConfig" WHERE key = ${key}
    `;
  }

  // ─── AI / Claude config ─────────────────────────────────────────────────────

  async getAiConfig() {
    const [storedKey, storedModel, storedMaxTokens] = await Promise.all([
      this.getValue("claude.apiKey"),
      this.getValue("claude.model"),
      this.getValue("claude.maxTokens"),
    ]);

    const envKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    const effectiveKey = storedKey || envKey || null;
    const configured = !!effectiveKey;

    return {
      configured,
      source: storedKey ? "database" : envKey ? "environment" : "none",
      keyPreview: effectiveKey ? `${effectiveKey.slice(0, 14)}...${effectiveKey.slice(-4)}` : null,
      model: storedModel ?? "claude-sonnet-4-5",
      maxTokens: storedMaxTokens ? parseInt(storedMaxTokens) : 4096,
      availableModels: CLAUDE_MODELS,
    };
  }

  async updateAiConfig(dto: { apiKey?: string; model?: string; maxTokens?: number }) {
    const tasks: Promise<void>[] = [];

    if (dto.apiKey !== undefined) {
      if (dto.apiKey === "") {
        tasks.push(this.deleteValue("claude.apiKey"));
      } else {
        tasks.push(this.setValue("claude.apiKey", dto.apiKey));
      }
    }

    if (dto.model !== undefined) {
      if (!CLAUDE_MODELS.includes(dto.model)) {
        throw new Error(`Unknown model: ${dto.model}`);
      }
      tasks.push(this.setValue("claude.model", dto.model));
    }

    if (dto.maxTokens !== undefined) {
      tasks.push(this.setValue("claude.maxTokens", String(dto.maxTokens)));
    }

    await Promise.all(tasks);
    return this.getAiConfig();
  }

  /**
   * Resolve the effective Anthropic API key for a given tenant.
   * Priority: tenant-specific key → platform key → ANTHROPIC_API_KEY env var
   */
  async resolveAnthropicKey(tenantSpecificKey?: string | null): Promise<string | null> {
    if (tenantSpecificKey) return tenantSpecificKey;
    const platformKey = await this.getValue("claude.apiKey");
    if (platformKey) return platformKey;
    return this.configService.get<string>("ANTHROPIC_API_KEY") ?? null;
  }

  async resolveModel(): Promise<string> {
    return (await this.getValue("claude.model")) ?? "claude-sonnet-4-5";
  }

  async resolveMaxTokens(): Promise<number> {
    const v = await this.getValue("claude.maxTokens");
    return v ? parseInt(v) : 4096;
  }
}
