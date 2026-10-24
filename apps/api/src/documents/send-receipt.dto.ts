import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsString, MaxLength } from "class-validator";
import { RECEIPT_CHANNEL_VALUES, type ReceiptChannel } from "./receipt-channels";

/** `SendReceiptRequest` of the shared contract. `to` is the cashier's typed address: it is never stored on a customer. */
export class SendReceiptDto {
  @IsIn(RECEIPT_CHANNEL_VALUES) channel: ReceiptChannel;

  /** padding trimmed first; a `Name <a@b.co>` form is not an address and fails `IsEmail` */
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(254)
  to: string;
}
