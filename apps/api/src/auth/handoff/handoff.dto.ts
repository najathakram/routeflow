import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

/** POST /auth/handoff and POST /buyer/auth/handoff (#2653). */
export class HandoffMintDto {
  @ApiProperty({ example: "ios-5f2c9a", description: "The app's stable device id" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  // Recorded as the new session's deviceName ("hybrid-shell:<deviceId>"): printable, no spaces.
  @Matches(/^[A-Za-z0-9._:-]+$/)
  deviceId: string;
}

/** POST /auth/handoff/exchange and POST /buyer/auth/handoff/exchange (#2653). */
export class HandoffExchangeDto {
  @ApiProperty({ description: "The one-time code from the /handoff URL fragment" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  code: string;
}
