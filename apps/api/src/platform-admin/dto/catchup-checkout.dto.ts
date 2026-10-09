import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** The catch-up checkout request: the stub the dry-run showed the owner, pinned in whole cents. */
export class CatchupCheckoutDto {
  @ApiPropertyOptional({
    description:
      "The catch-up amount (cents) the dry-run printed. The server refuses (409 CATCHUP_AMOUNT_CHANGED) when its fresh plan differs.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  expectedStubCents?: number;
}
