import { Module } from "@nestjs/common";
import { DriverLocationRetentionService } from "./driver-location-retention.service";
import { RetentionSwitchService } from "./retention-switch.service";

/** SA-1083: the scheduled retention jobs. PrismaModule and CommonModule are global. */
@Module({
  providers: [RetentionSwitchService, DriverLocationRetentionService],
})
export class RetentionModule {}
