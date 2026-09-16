import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { DemoBookingService } from "./demo-booking.service";
import {
  CancelDemoBookingDto,
  CreateDemoBookingDto,
  RescheduleDemoBookingDto,
} from "./dto/demo-booking.dto";

/**
 * Public, unauthenticated, tenant-less booking surface for the marketing site.
 *
 * Deliberately carries no `@UseGuards` — this API applies `JwtAuthGuard` per
 * route rather than globally (see the security note in `app.module.ts`), so the
 * absence of a guard here is the whole mechanism. Modelled on
 * `tenants/public-tenants.controller.ts`, the existing public controller.
 *
 * The manage token in the `:token` routes is the only credential: it is minted
 * per booking, emailed to the person who booked, and stored only as a hash.
 */
@ApiTags("public/demo-bookings")
@Controller("public/demo-bookings")
export class PublicDemoBookingController {
  constructor(private readonly bookings: DemoBookingService) {}

  @Get("availability")
  @ApiOperation({ summary: "Bookable demo slots in a date range, in the visitor's time zone" })
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async availability(
    @Query("from") from: string,
    @Query("to") to: string,
    @Query("timeZone") timeZone: string,
  ) {
    return this.bookings.getAvailability(from, to, timeZone);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Book a demo slot — creates the Google Calendar event" })
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async create(@Body() dto: CreateDemoBookingDto, @Req() req: Request) {
    const { booking } = await this.bookings.create({ ...dto, ip: req.ip });
    // The manage token is deliberately NOT returned: it reaches the visitor
    // through the confirmation email, which proves they own the address.
    return booking;
  }

  @Get(":token")
  @ApiOperation({ summary: "Read a booking by its manage token" })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async get(@Param("token") token: string) {
    return this.bookings.getByToken(token);
  }

  @Post(":token/reschedule")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Move a booking to a different slot" })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  async reschedule(@Param("token") token: string, @Body() dto: RescheduleDemoBookingDto) {
    return this.bookings.reschedule(token, dto.startsAt);
  }

  @Post(":token/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel a booking and remove the calendar event" })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  async cancel(@Param("token") token: string, @Body() dto: CancelDemoBookingDto) {
    return this.bookings.cancel(token, dto.reason);
  }
}
