import { Global, Module } from "@nestjs/common";
import { OperatorPermissionsService } from "./operator-permissions.service";

// Global so every module's `RolesGuard` can resolve the permission service (spec §4.1) without importing this module.
@Global()
@Module({
  providers: [OperatorPermissionsService],
  exports: [OperatorPermissionsService],
})
export class OperatorPermissionsModule {}
