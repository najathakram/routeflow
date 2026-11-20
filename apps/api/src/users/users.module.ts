import { Module, forwardRef } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { BillingModule } from "../billing/billing.module";
import { OperatorPermissionsModule } from "../auth/permissions/operator-permissions.module";

@Module({
  // BillingModule: AddonService, read only by the dark driver-row gate (B862 / SA-1171 K3).
  imports: [forwardRef(() => AuthModule), EmailModule, OperatorPermissionsModule, BillingModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
