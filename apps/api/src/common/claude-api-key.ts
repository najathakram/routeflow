import { applyDecorators, Logger } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsOptional, IsString, Matches } from "class-validator";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SA-1102 A-1(d): the one shape of an Anthropic API key a write endpoint accepts, and the one audit row a key change
 * writes. Both key endpoints (the business's `PATCH /settings/anthropic` and the platform's
 * `PATCH /platform-admin/ai-config`) use these, so a key can never be stored unvalidated or audited with more than its
 * last 4 characters.
 */
export const CLAUDE_API_KEY_MESSAGE = "That doesn't look like a Claude API key.";

/** `apiKey` is optional; when present it is trimmed, and is "" (clear) or a well-formed Claude key. */
export function ClaudeApiKey(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }) => (typeof value === "string" ? value.trim() : value)),
    IsString({ message: CLAUDE_API_KEY_MESSAGE }),
    Matches(/^(sk-ant-[A-Za-z0-9_-]{20,200})?$/, { message: CLAUDE_API_KEY_MESSAGE }),
  );
}

export type AiKeyAuditEntity = "SystemConfig" | "PlatformConfig";

/**
 * One AuditLog row per key change: `ai_key.set` with `meta: { last4 }`, or `ai_key.cleared` with no meta. The key
 * itself, and anything but its last 4 characters, never reaches the row, the log or an error message. Never throws:
 * an audit failure must not undo or block the key change.
 */
export async function auditAiKeyChange(
  prisma: Pick<PrismaService, "auditLog">,
  evt: {
    tenantId: string | null;
    userId: string | null;
    entityType: AiKeyAuditEntity;
    apiKey: string;
    impersonatedBy?: string | null;
  },
): Promise<void> {
  const cleared = evt.apiKey === "";
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: evt.tenantId,
        userId: evt.userId,
        action: cleared ? "ai_key.cleared" : "ai_key.set",
        entityType: evt.entityType,
        impersonatedBy: evt.impersonatedBy ?? null,
        ...(cleared ? {} : { meta: { last4: evt.apiKey.slice(-4) } }),
      },
    });
  } catch (err: any) {
    new Logger("auditAiKeyChange").error(
      `Failed to write the ai_key audit row (${evt.entityType}): ${err?.code ?? "error"}`,
    );
  }
}
