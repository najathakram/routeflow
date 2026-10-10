import { Module, forwardRef } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { OperatorPermissionsModule } from "../auth/permissions/operator-permissions.module";

@Module({
  imports: [forwardRef(() => AuthModule), EmailModule, OperatorPermissionsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
