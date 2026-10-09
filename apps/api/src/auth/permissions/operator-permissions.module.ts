import { Module } from "@nestjs/common";
import { OperatorPermissionsService } from "./operator-permissions.service";

@Module({
  providers: [OperatorPermissionsService],
  exports: [OperatorPermissionsService],
})
export class OperatorPermissionsModule {}
