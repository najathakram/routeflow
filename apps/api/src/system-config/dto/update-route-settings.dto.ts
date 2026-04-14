import { IsOptional, IsNumber, IsString, Min, Max, Matches } from "class-validator";

export class UpdateRouteSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  averageSpeedKmh?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(120)
  serviceTimeMinutes?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: "defaultStartTime must be in HH:MM format" })
  defaultStartTime?: string;
}
