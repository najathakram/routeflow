import { IsBoolean } from "class-validator";

/** Toggle a single NotificationRule cell (P6-6 matrix). */
export class UpdateRuleDto {
  @IsBoolean()
  enabled!: boolean;
}
