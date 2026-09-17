import { IsNotEmpty, IsString } from "class-validator";

/** `POST /settings/email/mailbox/confirm` request shape (security review fix round). */
export class ConfirmMailboxDto {
  @IsString()
  @IsNotEmpty()
  state!: string;
}
