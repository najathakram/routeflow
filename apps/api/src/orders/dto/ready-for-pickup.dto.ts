import { IsBoolean, IsOptional } from "class-validator";

/** POST /orders/:id/ready-for-pickup (W-1060): the body is optional; `resend` is the staff's "Send again". */
export class ReadyForPickupDto {
  @IsOptional()
  @IsBoolean()
  resend?: boolean;
}
