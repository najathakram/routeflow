import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

export enum ChangeRequestResolveAction {
  APPROVE_AT_STOP = "APPROVE_AT_STOP",
  APPROVE_NEXT_DELIVERY = "APPROVE_NEXT_DELIVERY",
  DECLINE = "DECLINE",
}

export class ResolveChangeRequestDto extends RestrictionAckDto {
  @IsEnum(ChangeRequestResolveAction)
  action!: ChangeRequestResolveAction;

  /** Required when action=DECLINE (service-enforced); optional context otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
