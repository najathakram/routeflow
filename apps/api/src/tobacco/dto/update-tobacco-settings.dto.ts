import { IsBoolean } from "class-validator";

export class UpdateTobaccoSettingsDto {
  /** Exclude tobacco items from the MAIN analytics surfaces (presentation only). */
  @IsBoolean()
  excludeFromMainAnalytics: boolean;
}
