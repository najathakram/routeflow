import { IsEmail, IsOptional, MaxLength } from "class-validator";

/** POST /customers/:id/account-statement/email (wire shape `SendAccountStatementEmailRequest`). A bad address is a 400 before any render. */
export class SendAccountStatementEmailDto {
  /** Where to send it; omitted = the address on file. */
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}
