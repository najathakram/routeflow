import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/** The raw invite token from the emailed link, POSTed in the body (never in a URL). */
export class InviteTokenDto {
  @ApiProperty({ description: "Raw invite token from the emailed link" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;
}
