import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsString } from "class-validator";

export class RequestSellerDto {
  @ApiProperty({ example: "acme-foods", description: "The seller's company code / slug" })
  @IsString()
  @IsNotEmpty()
  sellerSlug: string;

  @ApiProperty({
    example: "jane@example.com",
    description: "Email address you use with this seller (to match your customer record)",
  })
  @IsEmail()
  emailAtSeller: string;
}
