import { IsEnum } from "class-validator";
import { DriverStatus } from "@prisma/client";

export class ChangeDriverStatusDto {
  @IsEnum(DriverStatus) status: DriverStatus;
}
