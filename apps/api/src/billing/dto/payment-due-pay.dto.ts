import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, Min, ValidateIf, ValidateNested } from "class-validator";

/**
 * Row 542c: the terms the banner SHOWED (the SA-796 precondition pattern). These values are only COMPARED with the
 * server's fresh plan; they never price anything. Every key is required inside `shown` (null where the banner
 * showed none) so a half-filled quote cannot match by omission.
 */
export class PaymentDueShownDto {
  @ApiProperty({ description: "PaymentDueView.amountCents as shown (0 for an Add card banner)" })
  @IsInt()
  @Min(0)
  amountCents: number;

  @ApiProperty({
    nullable: true,
    description: "PaymentDueView.periodStart as shown (null for an Add card banner)",
  })
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601({ strict: true })
  periodStart: string | null;

  @ApiProperty({ nullable: true, description: "PaymentDueView.cardBy as shown (null for a bill)" })
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601({ strict: true })
  cardBy: string | null;
}

/**
 * `POST /billing/payment-due/pay` body. OPTIONAL for one release: an absent `shown` is today's behaviour (a page
 * cached before this deploy). The web always sends it.
 */
export class PaymentDuePayDto {
  @ApiPropertyOptional({ type: PaymentDueShownDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentDueShownDto)
  shown?: PaymentDueShownDto;
}
