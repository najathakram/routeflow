import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UploadsAccessGuard } from "./uploads-access.guard";
import { UploadsController } from "./uploads.controller";

@Module({
  imports: [AuthModule], // provides the passport "jwt" strategy used by UploadsAccessGuard
  controllers: [UploadsController],
  providers: [UploadsAccessGuard],
})
export class UploadsModule {}
