import { IsOptional, IsNumber, IsString, Min, Max, Matches, ValidateIf } from "class-validator";

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

  // Depot coordinates. ValidateIf (not IsOptional) so an explicit null is rejected,
  // not silently skipped; both must be sent together (enforced in the controller).
  @ValidateIf((_o, v) => v !== undefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  depotLat?: number;

  @ValidateIf((_o, v) => v !== undefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  depotLng?: number;
}
