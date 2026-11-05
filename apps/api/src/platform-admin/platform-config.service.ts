import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { roundMoney } from "@routeflow/pricing";
import type { AppLinks, AppLinksPatch } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { EncryptionService } from "../common/encryption.service";
import { auditAiKeyChange } from "../common/claude-api-key";
import { decryptIfSecret, encryptIfSecret, secretPreview } from "../common/secret-at-rest";
import { APP_LINK_FIELDS, APP_LINK_KEYS, isValidAppLinkUrl } from "./app-links";
import {
  AI_MODELS,
  AI_TASKS,
  aiModelFamily,
  isAiModelId,
  type AiModelFamily,
  type AiTask,
} from "./ai-models";

// Rough per-1M-token USD pricing (input, output) for the display-only "Est. spend" figure, not billing. Rates are
// Anthropic's published API prices, refreshed 2026-10-28 (SA-1035): Fable 5.1 10/50, Opus 5.5 4/20, Sonnet 5.5 2/10,
// Haiku 5.5 0.10/0.50 (the up-to-100k-token-prompt tier; a longer prompt is billed higher, so this under-reads it).
// A model is priced by its family on the AI_MODELS list.
const AI_MODEL_PRICING: Record<AiModelFamily, { in: number; out: number }> = {
  fable: { in: 10, out: 50 },
  opus: { in: 4, out: 20 },
  sonnet: { in: 2, out: 10 },
  haiku: { in: 0.1, out: 0.5 },
};

// An older stored id (not on the list) keeps the rates it was priced at before SA-1035.
const LEGACY_MODEL_PRICING: Partial<Record<AiModelFamily, { in: number; out: number }>> = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 2, out: 10 },
  haiku: { in: 1, out: 5 },
};

function modelPrice(model: string): { in: number; out: number } {
  const family = aiModelFamily(model);
  if (!isAiModelId(model)) return LEGACY_MODEL_PRICING[family] ?? AI_MODEL_PRICING[family];
  return AI_MODEL_PRICING[family];
}

/** The one estimate of spend from token sums, per model: the 30-day panel and the monthly budget both use it. */
function estimateSpendUsd(rows: Array<{ model: string; inTok: number; outTok: number }>): number {
  let usd = 0;
  for (const r of rows) {
    const price = modelPrice(r.model);
    usd += (Number(r.inTok) / 1e6) * price.in + (Number(r.outTok) / 1e6) * price.out;
  }
  return usd;
}

/** True for the 403 `assertAiBudget` throws, so a caller with a useful non-AI answer can degrade instead of failing. */
export function isMonthlyCapRefusal(err: unknown): boolean {
  const body = (err as { getResponse?: () => unknown })?.getResponse?.();
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: string }).code === API_ERROR_CODES.AI_MONTHLY_CAP_REACHED
  );
}

/** The first instant of the UTC month `now` falls in: the boundary the monthly AI allowance is summed from. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The first instant of the next UTC month: when a business's AI allowance starts again. */
export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The ISO date a refused business gets AI scans back: the 403 carries it; a refusal without one falls back to the next 1st. */
export function capResetsAt(err: unknown, now = new Date()): string {
  const body = (err as { getResponse?: () => unknown })?.getResponse?.() as
    { resetsAt?: unknown } | undefined;
  return typeof body?.resetsAt === "string" ? body.resetsAt : nextUtcMonthStart(now).toISOString();
}

/** SA-1102 B1: one business's monthly allowance on RouteFlow's key, in USD, when `ai.monthlyCapUsd` is unset. */
export const DEFAULT_MONTHLY_AI_CAP_USD = 25;

/**
 * Secret-valued PlatformConfig keys (SA-1102 2.1): encrypted at rest through the same helper and cipher as the
 * SystemConfig secrets. Exported so the boot report and the secret-keys pin read the one list. The other keys
 * (`claude.maxTokens`, `claude.verifiedAt`, `platform.houseTenantId`, ...) are not secrets.
 */
export const PLATFORM_SECRET_KEYS: ReadonlySet<string> = new Set(["claude.apiKey"]);

@Injectable()
export class PlatformConfigService {
  private readonly logger = new Logger(PlatformConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  // ─── Low-level helpers ──────────────────────────────────────────────────────

  private async getValue(key: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "PlatformConfig" WHERE key = ${key} LIMIT 1
    `;
    return decryptIfSecret(PLATFORM_SECRET_KEYS, this.encryption, key, rows[0]?.value ?? null, () =>
      this.logger.error(`Failed to decrypt PlatformConfig secret "${key}"`),
    );
  }

  private async setValue(key: string, plain: string): Promise<void> {
    const value = encryptIfSecret(PLATFORM_SECRET_KEYS, this.encryption, key, plain);
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
    const [storedKey, storedModel, storedScanModel, storedMaxTokens, verifiedAt] =
      await Promise.all([
        this.getValue("claude.apiKey"),
        this.getValue(AI_TASKS.general.key as string),
        this.getValue(AI_TASKS.bill_scan.key as string),
        this.getValue("claude.maxTokens"),
        this.getValue("claude.verifiedAt"),
      ]);

    // SA-1102: the Railway env key (the one with the spend limit) is first; the stored row only when env is unset.
    const envKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    const effectiveKey = envKey || storedKey || null;
    const configured = !!effectiveKey;

    return {
      configured,
      source: envKey ? "environment" : storedKey ? "database" : "none",
      keyPreview: secretPreview(effectiveKey),
      // A stored older id is reported as stored (never switched silently); the picker marks it "(older model)".
      model: storedModel ?? AI_TASKS.general.fallback,
      scanModel: storedScanModel ?? AI_TASKS.bill_scan.fallback,
      maxTokens: storedMaxTokens ? parseInt(storedMaxTokens) : 4096,
      verifiedAt,
      monthlyCapUsd: await this.monthlyCapUsdFor(""),
      availableModels: AI_MODELS.map(({ id, label }) => ({ id, label })),
    };
  }

  async updateAiConfig(
    dto: {
      apiKey?: string;
      model?: string;
      scanModel?: string;
      maxTokens?: number;
      monthlyCapUsd?: number;
    },
    actorId?: string | null,
  ) {
    // Validate every model BEFORE any write, so a bad id never leaves a half-saved config.
    for (const id of [dto.model, dto.scanModel]) {
      if (id !== undefined && !isAiModelId(id)) {
        throw new BadRequestException({
          code: API_ERROR_CODES.AI_MODEL_UNKNOWN,
          message: "That model is not one of the available models.",
        });
      }
    }

    const tasks: Promise<void>[] = [];

    if (dto.apiKey !== undefined) {
      if (dto.apiKey === "") {
        tasks.push(this.deleteValue("claude.apiKey"));
      } else {
        tasks.push(this.setValue("claude.apiKey", dto.apiKey));
      }
    }

    if (dto.model !== undefined)
      tasks.push(this.setValue(AI_TASKS.general.key as string, dto.model));
    if (dto.scanModel !== undefined) {
      tasks.push(this.setValue(AI_TASKS.bill_scan.key as string, dto.scanModel));
    }

    if (dto.maxTokens !== undefined) {
      tasks.push(this.setValue("claude.maxTokens", String(dto.maxTokens)));
    }

    if (dto.monthlyCapUsd !== undefined) {
      tasks.push(this.setValue("ai.monthlyCapUsd", String(dto.monthlyCapUsd)));
    }

    await Promise.all(tasks);
    // SA-1102 A-1(d): one audit row per key change, with the last 4 characters only.
    if (dto.apiKey !== undefined) {
      await auditAiKeyChange(this.prisma, {
        tenantId: null,
        userId: actorId ?? null,
        entityType: "PlatformConfig",
        apiKey: dto.apiKey,
      });
    }
    return this.getAiConfig();
  }

  /**
   * The Anthropic key a task runs on (SA-1102 2.3). A business's own key is used for `bill_scan` ONLY, and only when it
   * is non-empty; every other task, and a bill scan whose business key is unset or removed, runs on RouteFlow's key:
   * the Railway env `ANTHROPIC_API_KEY` first, then the encrypted `claude.apiKey` row. A business key that Anthropic
   * refuses is NOT retried on RouteFlow's key (the caller fails as before), so a revoked or stolen key shows.
   */
  async resolveAnthropicKey(
    task: AiTask,
    businessKey?: string | null,
  ): Promise<{ key: string | null; source: "business" | "routeflow" }> {
    if (task === "bill_scan" && businessKey) return { key: businessKey, source: "business" };
    const envKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (envKey) return { key: envKey, source: "routeflow" };
    return { key: await this.getValue("claude.apiKey"), source: "routeflow" };
  }

  /**
   * SA-1102 A-1(a): a business must be selected before ANY Anthropic call. A SUPER_ADMIN token with no business used to
   * reach every scan site (`TenantRequiredInterceptor` is dark), and a tenantless config read is unscoped. Runs before
   * any config read. Returns the tenant id.
   */
  requireAiTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
        message: "Choose a business before scanning.",
      });
    }
    return tenantId;
  }

  /**
   * SA-1102 A-1(a): the ONE entry point every Anthropic call site uses, in this order: the business (403
   * TENANT_CONTEXT_REQUIRED), the key by task (`resolveAnthropicKey`), the monthly budget when the key is RouteFlow's
   * (403 AI_MONTHLY_CAP_REACHED), then the task's model. `key` is null when none is configured: the caller keeps its
   * existing "not configured" answer, and no budget runs because no call will happen.
   */
  async prepareAiCall(
    task: AiTask,
    businessKey?: string | null,
  ): Promise<{
    key: string | null;
    source: "business" | "routeflow";
    model: string;
    tenantId: string;
  }> {
    const tenantId = this.requireAiTenant();
    const { key, source } = await this.resolveAnthropicKey(task, businessKey);
    if (key && source === "routeflow") await this.assertAiBudget(tenantId);
    const model = await this.resolveModelFor(task);
    return { key, source, model, tenantId };
  }

  /**
   * The monthly allowance for one business, in USD. Today it is the platform-wide `ai.monthlyCapUsd` (unset or
   * unreadable = $25, `"0"` = AI off on RouteFlow's key for every business). A per-business override plugs in here.
   */
  async monthlyCapUsdFor(_tenantId: string): Promise<number> {
    const raw = await this.getValue("ai.monthlyCapUsd");
    if (raw === null || raw.trim() === "") return DEFAULT_MONTHLY_AI_CAP_USD;
    const cap = Number(raw);
    return Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_MONTHLY_AI_CAP_USD;
  }

  /**
   * Refuse (403 AI_MONTHLY_CAP_REACHED) when this business's estimated spend this UTC month has reached its cap. Until
   * the B2 migration adds `keySource`, EVERY usage row counts, a business's own-key scans included; that is
   * conservative and never refuses an own-key call. It is a soft cap: concurrent calls can each pass and overshoot by
   * about one call each. The Anthropic workspace spend limit is the hard stop behind it.
   */
  async assertAiBudget(tenantId: string): Promise<void> {
    const cap = await this.monthlyCapUsdFor(tenantId);
    const now = new Date();
    const monthStart = utcMonthStart(now);
    const rows = await this.prisma.$queryRaw<
      Array<{ model: string; inTok: number; outTok: number }>
    >`
      SELECT "model",
             COALESCE(SUM("inputTokens"), 0)::float8 AS "inTok",
             COALESCE(SUM("outputTokens"), 0)::float8 AS "outTok"
      FROM "AiUsageEvent"
      WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${monthStart}
      GROUP BY "model"
    `;
    if (estimateSpendUsd(rows) >= cap) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.AI_MONTHLY_CAP_REACHED,
        resetsAt: nextUtcMonthStart(now).toISOString(),
        message:
          "This business has used this month's AI scans. They start again on the 1st. Contact RouteFlow to raise the limit.",
      });
    }
  }

  /** The model a task runs on: its stored setting (kept as stored, even an older id), else the task's fallback. */
  async resolveModelFor(task: AiTask): Promise<string> {
    const { key, fallback } = AI_TASKS[task];
    return ((key ? await this.getValue(key) : null) ?? fallback) as string;
  }

  /** The general model (route analysis, the connection test). */
  async resolveModel(): Promise<string> {
    return this.resolveModelFor("general");
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
      estSpendUsd += estimateSpendUsd([{ model: r.model, inTok, outTok }]);
    }

    return {
      days,
      ocrScans,
      forecastRuns,
      insightRuns,
      tokensIn,
      tokensOut,
      estSpendUsd: roundMoney(estSpendUsd),
      errorRate: totalCalls > 0 ? Math.round((failures / totalCalls) * 1000) / 10 : 0,
      totalCalls,
    };
  }

  /** Ping Anthropic with the effective key; persist verifiedAt on success. */
  async testConnection() {
    const { key } = await this.resolveAnthropicKey("general");
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

  // ─── Platform identity ──────────────────────────────────────────────────────

  async getHouseTenantId(): Promise<string | null> {
    return this.getValue("platform.houseTenantId");
  }

  async setHouseTenantId(tenantId: string): Promise<void> {
    await this.setValue("platform.houseTenantId", tenantId);
  }

  // ─── Mobile app install links (register row 559) ────────────────────────────

  /** The three install links; an absent, empty or invalid stored value reads as null (fails closed). */
  async getAppLinks(): Promise<AppLinks> {
    const values = await Promise.all(APP_LINK_FIELDS.map((f) => this.getValue(APP_LINK_KEYS[f])));
    const links: AppLinks = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };
    APP_LINK_FIELDS.forEach((field, i) => {
      const v = values[i]?.trim();
      links[field] = isValidAppLinkUrl(v) ? v : null;
    });
    return links;
  }

  /**
   * Applies a partial change: a string sets (trimmed, https only), "" or null clears the row, an absent
   * field is left alone. Every field is validated before anything is written, so a bad one writes nothing.
   */
  async setAppLinks(patch: AppLinksPatch): Promise<AppLinks> {
    const writes: Array<[(typeof APP_LINK_FIELDS)[number], string | null]> = [];
    for (const field of APP_LINK_FIELDS) {
      const raw = patch[field];
      if (raw === undefined) continue;
      // A non-string (number, array, object) is refused, never coerced into a URL.
      const value = raw === null ? "" : typeof raw === "string" ? raw.trim() : null;
      if (value === null || (value !== "" && !isValidAppLinkUrl(value))) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.APP_LINK_URL_INVALID,
          field,
          message: "Enter a full https:// link (up to 2048 characters).",
        });
      }
      writes.push([field, value === "" ? null : value]);
    }
    for (const [field, value] of writes) {
      if (value === null) await this.deleteValue(APP_LINK_KEYS[field]);
      else await this.setValue(APP_LINK_KEYS[field], value);
    }
    return this.getAppLinks();
  }
}
