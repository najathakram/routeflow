import { IsNotEmpty, IsString } from "class-validator";

/** `PATCH /crm/gohighlevel/connection` request shape (spec R1). */
export class SaveCrmConnectionDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;
}
