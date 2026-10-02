import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { IsIn, IsString, MaxLength, ValidateIf, validateSync } from "class-validator";
import { PaymentMethod } from "@prisma/client";

/** ValidateIf (not IsOptional) so an explicit null is rejected rather than skipped. */
const whenPresent = () => ValidateIf((_o, v) => v !== undefined);

/**
 * Body of PATCH /users/me/preferences — a flat string map with an ALLOW-LIST of keys (SA-602a).
 * Every key a client sends is declared here; an unknown key is a 400 (see PreferencesBodyPipe).
 * The `lowStockDigestEnabled` property name must equal `LOW_STOCK_DIGEST_PREF_KEY` (pinned by
 * users.controller.preferences.spec.ts).
 *
 * Senders / readers:
 *  - lowStockDigestEnabled: web LowStockDigestToggle -> LowStockDigestService (opt-out, "false")
 *  - pushEnabled: mobile lib/notification-prefs.ts -> NotificationsService (opt-out, "false")
 *  - staffOrderEmail: web Notifications toggle (WS4) -> messaging resolveStaffRecipients (opt-out, "false")
 *  - staffBuyerChangeEmail: same toggle group (WS4) -> messaging resolveStaffRecipients (opt-out, "false")
 *  - locale: web lib/i18n (en | es) -> web lib/i18n
 *  - bill.lastSupplierId: web vendor-bills create modal -> same modal (prefill)
 *  - payment.lastMethod: web vendor-bill record-payment -> same modal (default method)
 */
export class UpdatePreferencesDto {
  @whenPresent()
  @IsIn(["true", "false"], { message: 'lowStockDigestEnabled must be exactly "true" or "false"' })
  lowStockDigestEnabled?: string;

  @whenPresent()
  @IsIn(["true", "false"], { message: 'pushEnabled must be exactly "true" or "false"' })
  pushEnabled?: string;

  @whenPresent()
  @IsIn(["true", "false"], { message: 'staffOrderEmail must be exactly "true" or "false"' })
  staffOrderEmail?: string;

  @whenPresent()
  @IsIn(["true", "false"], { message: 'staffBuyerChangeEmail must be exactly "true" or "false"' })
  staffBuyerChangeEmail?: string;

  @whenPresent()
  @IsIn(["en", "es"], { message: "locale must be one of en, es" })
  locale?: string;

  @whenPresent()
  @IsString()
  @MaxLength(64)
  "bill.lastSupplierId"?: string;

  @whenPresent()
  @IsIn(Object.values(PaymentMethod), {
    message: "payment.lastMethod must be a PaymentMethod value",
  })
  "payment.lastMethod"?: string;
}

/**
 * The allow-listed preference keys. API code must not value-import `@routeflow/types` (TS source,
 * no dist), so this is the api's runtime copy; users.controller.preferences.spec.ts pins it
 * set-equal to the shared `PREFERENCE_KEYS` that web and mobile write through.
 */
export const PREFERENCE_KEYS = [
  "lowStockDigestEnabled",
  "pushEnabled",
  "staffOrderEmail",
  "staffBuyerChangeEmail",
  "locale",
  "bill.lastSupplierId",
  "payment.lastMethod",
] as const;

/**
 * Real allow-list: rejects unknown keys with 400, validates each known key, and returns ONLY the
 * validated allow-listed keys. The controller types its body as `Record<string, string>` so the
 * global whitelist/forbidNonWhitelisted pipe skips it; this param-level pipe does the work.
 */
@Injectable()
export class PreferencesBodyPipe implements PipeTransform {
  transform(value: unknown, _meta?: ArgumentMetadata): Record<string, string> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("preferences body must be an object");
    }
    const allowed = new Set<string>(PREFERENCE_KEYS);
    const unknown = Object.keys(value).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new BadRequestException(`unknown preference key(s): ${unknown.join(", ")}`);
    }
    const dto = plainToInstance(UpdatePreferencesDto, value);
    const errors = validateSync(dto);
    if (errors.length) {
      throw new BadRequestException(errors.flatMap((e) => Object.values(e.constraints ?? {})));
    }
    const out: Record<string, string> = {};
    for (const k of PREFERENCE_KEYS) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v as string;
    }
    return out;
  }
}
