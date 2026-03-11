import { IsEnum } from "class-validator";
import { UserStatus } from "@prisma/client";

export class ChangeCustomerStatusDto {
  @IsEnum(UserStatus) status: UserStatus;
}
