import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

/** Merge-verification token, POSTed in the body (never in a URL path or query). */
export class BuyerVerifyMergeDto {
  @ApiProperty({ description: "Raw verification token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  token: string;
}
