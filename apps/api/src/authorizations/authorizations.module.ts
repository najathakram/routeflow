import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationsController } from "./authorizations.controller";
import { AuthorizationsService } from "./authorizations.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { AuthorizationGuardService } from "./authorization-guard.service";

@Module({
  imports: [AuditModule],
  controllers: [AuthorizationsController],
  providers: [AuthorizationsService, AuthorizationOverridesService, AuthorizationGuardService],
  // Exported so Orders/Invoices can enforce the license guard at sale time.
  exports: [AuthorizationGuardService],
})
export class AuthorizationsModule {}
