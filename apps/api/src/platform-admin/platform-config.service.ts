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

// Rough per-1M-token USD pricing (input, output) for the display-only "Est.
// spend" figure — not billing.
const AI_MODEL_PRICING: Record<string, { in: number; out: number }> = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
};

function modelPrice(model: string): { in: number; out: number } {
  const m = model.toLowerCase();
  if (m.includes("opus")) return AI_MODEL_PRICING.opus;
  if (m.includes("haiku")) return AI_MODEL_PRICING.haiku;
  return AI_MODEL_PRICING.sonnet;
}

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
      // AI usage/metering log — additive + idempotent (same auto-create pattern
      // as PlatformConfig above, so no Prisma migration is required to ship).
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "AiUsageEvent" (
          "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
          "tenantId"     TEXT,
          "feature"      TEXT NOT NULL,
          "model"        TEXT NOT NULL,
          "inputTokens"  INTEGER NOT NULL DEFAULT 0,
          "outputTokens" INTEGER NOT NULL DEFAULT 0,
          "success"      BOOLEAN NOT NULL DEFAULT true,
          "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now(),
          CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "AiUsageEvent_createdAt_idx" ON "AiUsageEvent"("createdAt")
      `;
      this.logger.log("PlatformConfig + AiUsageEvent tables ready");
    } catch (err: any) {
      this.logger.error(`Platform table setup failed: ${err?.message}`);
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
    const [storedKey, storedModel, storedMaxTokens, verifiedAt] = await Promise.all([
      this.getValue("claude.apiKey"),
      this.getValue("claude.model"),
      this.getValue("claude.maxTokens"),
      this.getValue("claude.verifiedAt"),
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
      verifiedAt,
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

  // ─── AI usage metering + connection test ────────────────────────────────────

  /**
   * Append a usage row. Called by every Anthropic call site: vendor-bill scan
   * (`ocr.vendor_bill`), supplier-statement scan (`ocr.supplier_statement`),
   * expense-receipt extraction (`ocr.expense_receipt`), and route insights
   * (`insights.route`). Never throws — metering must not fail the feature.
   */
  async recordAiUsage(evt: {
    tenantId?: string | null;
    feature: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    success?: boolean;
  }): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "AiUsageEvent"
          ("id","tenantId","feature","model","inputTokens","outputTokens","success","createdAt")
        VALUES (gen_random_uuid()::text, ${evt.tenantId ?? null}, ${evt.feature}, ${evt.model},
                ${evt.inputTokens ?? 0}, ${evt.outputTokens ?? 0}, ${evt.success ?? true}, now())
      `;
    } catch (err: any) {
      this.logger.warn(`recordAiUsage failed: ${err?.message}`);
    }
  }

  /** 30-day AI usage rollup for the admin AI Settings panel. */
  async getAiUsage(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let rows: Array<{
      model: string;
      feature: string;
      calls: number;
      inTok: number;
      outTok: number;
      failures: number;
    }> = [];
    try {
      rows = await this.prisma.$queryRaw`
        SELECT "model", "feature",
               COUNT(*)::int AS calls,
               COALESCE(SUM("inputTokens"), 0)::float8 AS "inTok",
               COALESCE(SUM("outputTokens"), 0)::float8 AS "outTok",
               SUM(CASE WHEN "success" THEN 0 ELSE 1 END)::int AS failures
        FROM "AiUsageEvent"
        WHERE "createdAt" >= ${cutoff}
        GROUP BY "model", "feature"
      `;
    } catch {
      rows = [];
    }

    let ocrScans = 0;
    let forecastRuns = 0;
    let insightRuns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let totalCalls = 0;
    let failures = 0;
    let estSpendUsd = 0;
    for (const r of rows) {
      const calls = Number(r.calls);
      const inTok = Number(r.inTok);
      const outTok = Number(r.outTok);
      totalCalls += calls;
      failures += Number(r.failures);
      tokensIn += inTok;
      tokensOut += outTok;
      if (r.feature === "ocr" || r.feature.startsWith("ocr.")) ocrScans += calls;
      if (r.feature === "forecast" || r.feature.startsWith("forecast.")) forecastRuns += calls;
      if (r.feature.startsWith("insights.")) insightRuns += calls;
      const price = modelPrice(r.model);
      estSpendUsd += (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
    }

    return {
      days,
      ocrScans,
      forecastRuns,
      insightRuns,
      tokensIn,
      tokensOut,
      estSpendUsd: Math.round(estSpendUsd * 100) / 100,
      errorRate: totalCalls > 0 ? Math.round((failures / totalCalls) * 1000) / 10 : 0,
      totalCalls,
    };
  }

  /** Ping Anthropic with the effective key; persist verifiedAt on success. */
  async testConnection() {
    const key = await this.resolveAnthropicKey();
    if (!key) return { ok: false, error: "No API key configured" };
    const model = await this.resolveModel();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) {
        const verifiedAt = new Date().toISOString();
        await this.setValue("claude.verifiedAt", verifiedAt);
        return { ok: true, model, verifiedAt };
      }
      const body: any = await res.json().catch(() => ({}));
      return { ok: false, model, error: body?.error?.message ?? `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, model, error: err?.message ?? "Request failed" };
    }
  }
}
