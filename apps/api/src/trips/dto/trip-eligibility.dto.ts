import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from "class-validator";

export class TripEligibilityQueryDto {
  @Transform(({ value }) => (typeof value === "string" ? value.split(",").filter(Boolean) : value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds!: string[];
}
