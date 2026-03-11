import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "driver" })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: "password" })
  @IsString()
  @IsNotEmpty()
  password: string;
}
