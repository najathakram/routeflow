import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailModule } from "../email/email.module";
import {
  AuthorizationsController,
  ExpiringAuthorizationsController,
} from "./authorizations.controller";
import { AuthorizationsService } from "./authorizations.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { AuthorizationGuardService } from "./authorization-guard.service";
import { AuthorizationExpiryService } from "./authorization-expiry.service";

@Module({
  imports: [AuditModule, NotificationsModule, EmailModule],
  controllers: [AuthorizationsController, ExpiringAuthorizationsController],
  providers: [
    AuthorizationsService,
    AuthorizationOverridesService,
    AuthorizationGuardService,
    AuthorizationExpiryService,
  ],
  // AuthorizationGuardService → Orders/Invoices enforce the license guard at sale time.
  // AuthorizationsService → the buyer portal reuses it for self-serve submit/list (W6b)
  //   and expiring-license reads (W7b).
  exports: [AuthorizationGuardService, AuthorizationsService],
})
export class AuthorizationsModule {}
