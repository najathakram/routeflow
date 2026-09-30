import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { IsIn, ValidateIf, validateSync } from "class-validator";

/**
 * Body of PATCH /users/me/preferences. The map stays permissive for other keys (mobile writes
 * `pushEnabled` etc.); only the low-stock digest key is validated. The property name must equal
 * `LOW_STOCK_DIGEST_PREF_KEY` (pinned by users.controller.preferences.spec.ts).
 */
export class UpdatePreferencesDto {
  // ValidateIf (not IsOptional) so an explicit null is rejected rather than skipped.
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(["true", "false"], { message: 'lowStockDigestEnabled must be exactly "true" or "false"' })
  lowStockDigestEnabled?: string;
}

/**
 * Validates the typed keys without whitelisting the rest. The controller types its body as
 * `Record<string, string>` so the global whitelist/forbidNonWhitelisted pipe skips it; this
 * param-level pipe then applies the DTO's rules only.
 */
@Injectable()
export class PreferencesBodyPipe implements PipeTransform {
  transform(value: unknown, _meta?: ArgumentMetadata) {
    const dto = plainToInstance(UpdatePreferencesDto, value ?? {});
    const errors = validateSync(dto);
    if (errors.length) {
      throw new BadRequestException(errors.flatMap((e) => Object.values(e.constraints ?? {})));
    }
    return value;
  }
}
