import { IsIn, IsOptional } from "class-validator";
import { RESTRICTION_ADDRESS_PRECEDENCE_VALUES } from "../selling-restrictions/selling-restrictions.service";

/** Row 510: `enabled` is gone (the whitelist ValidationPipe rejects it as a non-whitelisted key, 400). */
export class UpdateRestrictionsSettingsDto {
  @IsOptional()
  @IsIn(RESTRICTION_ADDRESS_PRECEDENCE_VALUES)
  governingAddress?: (typeof RESTRICTION_ADDRESS_PRECEDENCE_VALUES)[number];
}
