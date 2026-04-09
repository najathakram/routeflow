import { IsInt, Min, Max } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ExtendTrialDto {
  @ApiProperty({ description: "Number of days from now", minimum: 1, maximum: 365 })
  @IsInt()
  @Min(1)
  @Max(365)
  days: number;
}
