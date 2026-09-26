import { IsNotEmpty, IsString } from "class-validator";

/**
 * #2309 (SA-418): body for POST /auth/apple/notifications — Apple's server-to-server
 * notification, a JWS whose payload carries the event (consent-revoked, account-delete,
 * email-disabled). Field name matches Apple's own webhook contract.
 */
export class AppleNotificationDto {
  @IsString()
  @IsNotEmpty()
  signedPayload!: string;
}
