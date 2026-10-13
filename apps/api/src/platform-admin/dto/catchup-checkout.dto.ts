import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

/** The catch-up checkout request: the stub the dry-run showed the owner, pinned in whole cents. */
export class CatchupCheckoutDto {
  @ApiProperty({
    description:
      "The catch-up amount (cents) the dry-run printed. The server refuses (409 CATCHUP_AMOUNT_CHANGED) when its fresh plan differs.",
  })
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  expectedStubCents!: number;
}
