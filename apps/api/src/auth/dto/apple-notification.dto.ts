import { IsNotEmpty, IsOptional, IsString, ValidateIf } from "class-validator";

/**
 * #2309 (SA-418): body for POST /auth/apple/notifications — Apple's server-to-server
 * notification for Sign in with Apple: JSON `{ "payload": "<JWT>" }` whose JWS carries the event
 * (consent-revoked, account-delete, email-disabled). `payload` is Apple's real field name;
 * `signedPayload` (the App Store Server Notifications name) is still accepted for older callers.
 * Exactly one of the two must be a non-empty string; the global ValidationPipe forbids anything else.
 */
export class AppleNotificationDto {
  @ValidateIf((o: AppleNotificationDto) => o.payload !== undefined || o.signedPayload === undefined)
  @IsString()
  @IsNotEmpty()
  payload?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  signedPayload?: string;
}
