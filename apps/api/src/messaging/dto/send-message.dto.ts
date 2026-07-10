import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { MessageChannel, NotificationEvent } from "@prisma/client";

export class SendMessageDto {
  @IsEnum(MessageChannel)
  channel!: MessageChannel;

  @IsString()
  @MaxLength(2000)
  body!: string;

  /** Optional event context — enforces the invoice-channel policy (G12). */
  @IsOptional()
  @IsEnum(NotificationEvent)
  eventKey?: NotificationEvent;
}
