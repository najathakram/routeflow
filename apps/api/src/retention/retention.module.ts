import { Module } from "@nestjs/common";
import { DemoBookingModule } from "../demo-booking/demo-booking.module";
import { DemoBookingRetentionService } from "./demo-booking-retention.service";
import { DriverLocationRetentionService } from "./driver-location-retention.service";
import { RetentionSwitchService } from "./retention-switch.service";

/** SA-1083: the scheduled retention jobs. PrismaModule and CommonModule are global. */
@Module({
  imports: [DemoBookingModule],
  providers: [RetentionSwitchService, DriverLocationRetentionService, DemoBookingRetentionService],
})
export class RetentionModule {}
