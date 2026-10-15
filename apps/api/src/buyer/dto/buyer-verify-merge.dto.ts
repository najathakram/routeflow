import { ApiProperty } from "@nestjs/swagger";
import { IsHexadecimal, IsNotEmpty, IsString, Length } from "class-validator";

/**
 * Mirrors BuyerVerifyEmailDto: the single-use merge-verification token is POSTed in the body, never
 * in the URL path (a path lands in access logs), and only on an explicit confirm click.
 */
export class BuyerVerifyMergeDto {
  @ApiProperty({ description: "Raw merge-verification token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  // randomBytes(32).toString("hex"): exactly 64 hex chars
  @Length(64, 64)
  @IsHexadecimal()
  token: string;
}
