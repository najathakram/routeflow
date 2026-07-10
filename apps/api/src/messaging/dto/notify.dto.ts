import { IsEnum, IsObject, IsOptional, IsString } from "class-validator";
import { NotificationEvent } from "@prisma/client";

export class NotifyDto {
  @IsEnum(NotificationEvent)
  eventKey!: NotificationEvent;

  @IsString()
  customerId!: string;

  /** Template variables for `{{placeholder}}` substitution. */
  @IsOptional()
  @IsObject()
  vars?: Record<string, string | number>;
}
