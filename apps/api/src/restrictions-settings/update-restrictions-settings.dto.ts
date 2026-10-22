import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { RESTRICTION_ADDRESS_PRECEDENCE_VALUES } from "../selling-restrictions/selling-restrictions.service";

export class UpdateRestrictionsSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsOptional()
  @IsIn(RESTRICTION_ADDRESS_PRECEDENCE_VALUES)
  governingAddress?: (typeof RESTRICTION_ADDRESS_PRECEDENCE_VALUES)[number];
}
