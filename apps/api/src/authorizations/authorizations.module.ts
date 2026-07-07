import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailModule } from "../email/email.module";
import { AuthorizationsController } from "./authorizations.controller";
import { AuthorizationsService } from "./authorizations.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { AuthorizationGuardService } from "./authorization-guard.service";
import { AuthorizationExpiryService } from "./authorization-expiry.service";

@Module({
  imports: [AuditModule, NotificationsModule, EmailModule],
  controllers: [AuthorizationsController],
  providers: [
    AuthorizationsService,
    AuthorizationOverridesService,
    AuthorizationGuardService,
    AuthorizationExpiryService,
  ],
  // Exported so Orders/Invoices can enforce the license guard at sale time.
  exports: [AuthorizationGuardService],
})
export class AuthorizationsModule {}
