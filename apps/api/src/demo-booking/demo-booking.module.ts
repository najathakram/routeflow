import { Module } from "@nestjs/common";
import { DemoBookingService } from "./demo-booking.service";
import { GoogleCalendarService } from "./google-calendar.service";
import { PublicDemoBookingController } from "./public-demo-booking.controller";
import { EmailModule } from "../email/email.module";

/**
 * Public demo booking for the marketing site. PrismaModule and CommonModule are
 * global; EmailModule is not, so it is imported explicitly here — the same DI
 * scope mistake that took the API down on 2026-09-12 (lesson L-113).
 */
@Module({
  imports: [EmailModule],
  controllers: [PublicDemoBookingController],
  providers: [DemoBookingService, GoogleCalendarService],
  exports: [DemoBookingService],
})
export class DemoBookingModule {}
