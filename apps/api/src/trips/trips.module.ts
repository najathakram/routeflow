import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { AuthModule } from "../auth/auth.module";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [AuthModule, SystemConfigModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
