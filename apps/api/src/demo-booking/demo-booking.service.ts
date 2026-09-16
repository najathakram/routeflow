import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DemoBooking, DemoBookingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import {
  DemoBookingConfig,
  isCalendarConfigured,
  isTokenSigningConfigured,
  loadDemoBookingConfig,
} from "./demo-booking.config";
import { BusyBlock, GoogleCalendarService } from "./google-calendar.service";
import { isValidTimeZone, zonedDateParts, zonedWallClockToUtc } from "./zoned-time";

export interface AvailabilitySlot {
  /** Slot start as a UTC ISO instant — the only value a client sends back. */
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityDay {
  /** `YYYY-MM-DD` in the *visitor's* zone. */
  date: string;
  slots: AvailabilitySlot[];
}

export interface AvailabilityResult {
  timeZone: string;
  durationMinutes: number;
  days: AvailabilityDay[];
}

export interface CreateBookingInput {
  name: string;
  email: string;
  company: string;
  phone?: string;
  notes?: string;
  startsAt: string;
  timeZone: string;
  sourcePage?: string;
  ip?: string;
}

/** What the marketing site is allowed to see about a booking. */
export interface PublicBooking {
  id: string;
  name: string;
  email: string;
  company: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: DemoBookingStatus;
  meetUrl: string | null;
  durationMinutes: number;
}

const MAX_WINDOW_DAYS = 62;

@Injectable()
export class DemoBookingService {
  private readonly logger = new Logger(DemoBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: GoogleCalendarService,
    private readonly email: EmailService,
  ) {}

  /** Overridable in tests; production reads `process.env` on every call. */
  protected config(): DemoBookingConfig {
    return loadDemoBookingConfig();
  }

  protected now(): Date {
    return new Date();
  }

  // ───────────────────────────────────────────────────────────── availability

  /**
   * Bookable slots between two dates, in the visitor's own time zone.
   *
   * Slots come from the configured business hours, minus anything Google
   * reports busy, minus anything already booked here, minus anything inside
   * the minimum-notice window. When the calendar cannot be reached the result
   * is **empty**, never a guess — `getBusy` returning null is the signal.
   */
  async getAvailability(
    fromISO: string,
    toISO: string,
    timeZone: string,
  ): Promise<AvailabilityResult> {
    const config = this.config();
    const visitorZone = isValidTimeZone(timeZone) ? timeZone : config.businessTimeZone;

    if (!isCalendarConfigured(config)) {
      this.logger.warn("demo-booking: calendar not configured — reporting no availability");
      return { timeZone: visitorZone, durationMinutes: config.durationMinutes, days: [] };
    }

    const now = this.now();
    const { windowStart, windowEnd } = this.resolveWindow(fromISO, toISO, now, config);
    if (windowEnd <= windowStart) {
      return { timeZone: visitorZone, durationMinutes: config.durationMinutes, days: [] };
    }

    const busy = await this.calendar.getBusy(windowStart, windowEnd);
    if (busy === null) {
      // Unreachable calendar. Offering slots here is how a prospect books a
      // time the team is not actually free for, so offer none.
      return { timeZone: visitorZone, durationMinutes: config.durationMinutes, days: [] };
    }

    const held = await this.prisma.demoBooking.findMany({
      where: {
        status: DemoBookingStatus.CONFIRMED,
        startsAt: { lt: windowEnd },
        endsAt: { gt: windowStart },
      },
      select: { startsAt: true, endsAt: true },
    });
    const blocked: BusyBlock[] = [
      ...busy,
      ...held.map((row) => ({ start: row.startsAt, end: row.endsAt })),
    ];

    const earliest = new Date(now.getTime() + config.minNoticeHours * 3_600_000);
    const candidates = this.generateSlots(windowStart, windowEnd, config);

    const byDate = new Map<string, AvailabilitySlot[]>();
    for (const slot of candidates) {
      if (slot.start < earliest) continue;
      if (blocked.some((block) => slot.start < block.end && slot.end > block.start)) continue;
      // Group by the visitor's calendar day, not the business's — the grid they
      // click is drawn in their zone.
      const { year, month, day } = zonedDateParts(slot.start, visitorZone);
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const bucket = byDate.get(key) ?? [];
      bucket.push({ startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString() });
      byDate.set(key, bucket);
    }

    return {
      timeZone: visitorZone,
      durationMinutes: config.durationMinutes,
      days: [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, slots]) => ({ date, slots })),
    };
  }

  /** Clamps the requested range to now…maxAdvanceDays and a hard span cap. */
  private resolveWindow(fromISO: string, toISO: string, now: Date, config: DemoBookingConfig) {
    const requestedStart = parseInstant(fromISO);
    const requestedEnd = parseInstant(toISO);
    const horizon = new Date(now.getTime() + config.maxAdvanceDays * 86_400_000);

    const windowStart = new Date(
      Math.max(requestedStart?.getTime() ?? now.getTime(), now.getTime()),
    );
    const proposedEnd = requestedEnd ?? new Date(windowStart.getTime() + 14 * 86_400_000);
    const cappedEnd = new Date(
      Math.min(
        proposedEnd.getTime(),
        horizon.getTime(),
        windowStart.getTime() + MAX_WINDOW_DAYS * 86_400_000,
      ),
    );
    return { windowStart, windowEnd: cappedEnd };
  }

  /**
   * Every business-hours slot whose start falls inside the window.
   *
   * Walks *business-zone calendar days* rather than adding 24h repeatedly, so a
   * DST transition shifts the slots' UTC instants and leaves their local times
   * where the business expects them.
   */
  private generateSlots(from: Date, to: Date, config: DemoBookingConfig) {
    const slots: Array<{ start: Date; end: Date }> = [];
    const zone = config.businessTimeZone;
    const openMinutes = config.openHour * 60 + config.openMinute;
    const closeMinutes = config.closeHour * 60 + config.closeMinute;
    const step = Math.max(5, config.slotIntervalMinutes);
    const duration = Math.max(5, config.durationMinutes);

    // Start a day early: a slot on the business's previous local day can still
    // begin after `from` in UTC when the visitor is far to the east.
    const cursor = zonedDateParts(new Date(from.getTime() - 86_400_000), zone);
    let { year, month, day } = cursor;

    for (let guard = 0; guard < MAX_WINDOW_DAYS + 3; guard += 1) {
      const dayStart = zonedWallClockToUtc(year, month, day, 0, 0, zone);
      if (dayStart.getTime() > to.getTime() + 86_400_000) break;

      const weekday = zonedDateParts(
        zonedWallClockToUtc(year, month, day, 12, 0, zone),
        zone,
      ).weekday;

      if (config.weekdays.includes(weekday)) {
        for (let minute = openMinutes; minute + duration <= closeMinutes; minute += step) {
          const start = zonedWallClockToUtc(
            year,
            month,
            day,
            Math.floor(minute / 60),
            minute % 60,
            zone,
          );
          const end = new Date(start.getTime() + duration * 60_000);
          if (start >= from && start < to) slots.push({ start, end });
        }
      }

      const next = new Date(Date.UTC(year, month - 1, day + 1));
      year = next.getUTCFullYear();
      month = next.getUTCMonth() + 1;
      day = next.getUTCDate();
    }

    return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  // ─────────────────────────────────────────────────────────────── booking

  async create(
    input: CreateBookingInput,
  ): Promise<{ booking: PublicBooking; manageToken: string }> {
    const config = this.config();
    this.assertBookable(config);

    const startsAt = parseInstant(input.startsAt);
    if (!startsAt) throw new BadRequestException("A valid start time is required.");
    const endsAt = new Date(startsAt.getTime() + config.durationMinutes * 60_000);
    const visitorZone = isValidTimeZone(input.timeZone) ? input.timeZone : config.businessTimeZone;

    await this.assertSlotStillFree(startsAt, endsAt, config);

    const manageToken = this.mintToken();
    const created = await this.prisma.demoBooking.create({
      data: {
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        company: input.company.trim(),
        phone: input.phone?.trim() || null,
        notes: input.notes?.trim() || null,
        startsAt,
        endsAt,
        timeZone: visitorZone,
        manageTokenHash: hashToken(manageToken),
        sourcePage: input.sourcePage?.slice(0, 200) ?? null,
        createdIp: input.ip?.slice(0, 64) ?? null,
      },
    });

    // The lead is captured before Google is touched: a calendar outage must
    // never lose the prospect's details.
    let withEvent = created;
    try {
      const event = await this.calendar.createEvent({
        ...this.eventShape(created),
        withMeet: true,
      });
      withEvent = await this.prisma.demoBooking.update({
        where: { id: created.id },
        data: { googleEventId: event.id, meetUrl: event.meetUrl },
      });
    } catch (error) {
      this.logger.error(
        `demo-booking: captured lead ${created.id} but the calendar write failed — ${String(error)}`,
      );
    }

    await this.sendConfirmation(withEvent, manageToken, "booked");
    return { booking: this.toPublic(withEvent, config), manageToken };
  }

  async cancel(token: string, reason?: string): Promise<PublicBooking> {
    const config = this.config();
    const booking = await this.requireByToken(token);
    if (booking.status === DemoBookingStatus.CANCELLED) {
      return this.toPublic(booking, config);
    }

    if (booking.googleEventId) {
      try {
        await this.calendar.deleteEvent(booking.googleEventId);
      } catch (error) {
        // The row is still cancelled — a stale calendar entry is a smaller
        // problem than a prospect who believes they cancelled and did not.
        this.logger.error(
          `demo-booking: cancelled ${booking.id} but could not remove event ${booking.googleEventId} — ${String(error)}`,
        );
      }
    }

    const cancelled = await this.prisma.demoBooking.update({
      where: { id: booking.id },
      data: {
        status: DemoBookingStatus.CANCELLED,
        cancelledAt: this.now(),
        cancelReason: reason?.trim().slice(0, 500) || null,
      },
    });
    await this.sendConfirmation(cancelled, token, "cancelled");
    return this.toPublic(cancelled, config);
  }

  async reschedule(token: string, newStartISO: string): Promise<PublicBooking> {
    const config = this.config();
    this.assertBookable(config);
    const booking = await this.requireByToken(token);
    if (booking.status === DemoBookingStatus.CANCELLED) {
      throw new ConflictException("This booking was cancelled. Please book a new time.");
    }

    const startsAt = parseInstant(newStartISO);
    if (!startsAt) throw new BadRequestException("A valid start time is required.");
    const endsAt = new Date(startsAt.getTime() + config.durationMinutes * 60_000);
    if (startsAt.getTime() === booking.startsAt.getTime()) {
      return this.toPublic(booking, config);
    }
    await this.assertSlotStillFree(startsAt, endsAt, config, booking.id);

    const moved = await this.prisma.demoBooking.update({
      where: { id: booking.id },
      data: {
        startsAt,
        endsAt,
        rescheduledFrom: booking.startsAt,
        rescheduleCount: { increment: 1 },
      },
    });

    if (moved.googleEventId) {
      try {
        await this.calendar.updateEvent(moved.googleEventId, this.eventShape(moved));
      } catch (error) {
        this.logger.error(
          `demo-booking: moved ${moved.id} but could not update event ${moved.googleEventId} — ${String(error)}`,
        );
      }
    }

    await this.sendConfirmation(moved, token, "rescheduled");
    return this.toPublic(moved, config);
  }

  async getByToken(token: string): Promise<PublicBooking> {
    return this.toPublic(await this.requireByToken(token), this.config());
  }

  // ─────────────────────────────────────────────────────────────── internals

  private assertBookable(config: DemoBookingConfig): void {
    if (!isCalendarConfigured(config) || !isTokenSigningConfigured(config)) {
      throw new ServiceUnavailableException(
        "Demo booking is not available right now. Please email us and we will arrange a time.",
      );
    }
  }

  /**
   * Re-checks the slot at write time. Availability is a read of a moving
   * target, so two visitors can be shown the same slot; this is the only place
   * that decides who gets it.
   */
  private async assertSlotStillFree(
    startsAt: Date,
    endsAt: Date,
    config: DemoBookingConfig,
    excludeId?: string,
  ): Promise<void> {
    const now = this.now();
    const earliest = new Date(now.getTime() + config.minNoticeHours * 3_600_000);
    if (startsAt < earliest) {
      throw new ConflictException(
        `Please choose a time at least ${config.minNoticeHours} hours from now.`,
      );
    }
    const horizon = new Date(now.getTime() + config.maxAdvanceDays * 86_400_000);
    if (startsAt > horizon) {
      throw new ConflictException(
        `Please choose a time within the next ${config.maxAdvanceDays} days.`,
      );
    }
    if (!this.isBusinessHoursSlot(startsAt, config)) {
      throw new ConflictException("That time is outside our booking hours.");
    }

    const clash = await this.prisma.demoBooking.findFirst({
      where: {
        status: DemoBookingStatus.CONFIRMED,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException("That time was just taken. Please pick another.");

    const busy = await this.calendar.getBusy(startsAt, endsAt);
    if (busy === null) {
      throw new ServiceUnavailableException(
        "We could not confirm that time against our calendar. Please try again shortly.",
      );
    }
    if (busy.some((block) => startsAt < block.end && endsAt > block.start)) {
      throw new ConflictException("That time was just taken. Please pick another.");
    }
  }

  /** True when the slot starts on a bookable weekday inside business hours. */
  private isBusinessHoursSlot(startsAt: Date, config: DemoBookingConfig): boolean {
    const zone = config.businessTimeZone;
    const { year, month, day, weekday } = zonedDateParts(startsAt, zone);
    if (!config.weekdays.includes(weekday)) return false;

    const dayOpen = zonedWallClockToUtc(year, month, day, config.openHour, config.openMinute, zone);
    const dayClose = zonedWallClockToUtc(
      year,
      month,
      day,
      config.closeHour,
      config.closeMinute,
      zone,
    );
    const latestStart = new Date(dayClose.getTime() - config.durationMinutes * 60_000);
    if (startsAt < dayOpen || startsAt > latestStart) return false;

    // Must sit on the published grid, not an arbitrary minute between slots.
    const offsetMinutes = (startsAt.getTime() - dayOpen.getTime()) / 60_000;
    const step = Math.max(5, config.slotIntervalMinutes);
    return Number.isInteger(offsetMinutes) && offsetMinutes % step === 0;
  }

  private async requireByToken(token: string): Promise<DemoBooking> {
    if (!token || token.length < 16) throw new NotFoundException("Booking not found.");
    if (!this.verifyToken(token)) throw new NotFoundException("Booking not found.");
    const booking = await this.prisma.demoBooking.findUnique({
      where: { manageTokenHash: hashToken(token) },
    });
    if (!booking) throw new NotFoundException("Booking not found.");
    return booking;
  }

  /**
   * Manage token: `<random>.<hmac>`. The HMAC lets an obviously forged token be
   * rejected without a database round trip; the stored SHA-256 of the whole
   * token is what actually resolves the row, so a database read alone cannot
   * cancel anyone's booking.
   */
  private mintToken(): string {
    const nonce = randomBytes(24).toString("base64url");
    return `${nonce}.${this.signature(nonce)}`;
  }

  private verifyToken(token: string): boolean {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return false;
    const nonce = token.slice(0, separator);
    const provided = Buffer.from(token.slice(separator + 1));
    const expected = Buffer.from(this.signature(nonce));
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private signature(nonce: string): string {
    return createHmac("sha256", this.config().tokenSecret).update(nonce).digest("base64url");
  }

  private eventShape(booking: DemoBooking) {
    const lines = [
      `RouteFlow product walkthrough with ${booking.name} (${booking.company}).`,
      "",
      `Contact: ${booking.email}`,
      ...(booking.phone ? [`Phone: ${booking.phone}`] : []),
      "",
      ...(booking.notes ? ["What they want to cover:", booking.notes] : []),
    ];
    return {
      summary: `RouteFlow demo — ${booking.company}`,
      description: lines.join("\n").trim(),
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      timeZone: booking.timeZone,
      attendeeEmail: booking.email,
      attendeeName: booking.name,
    };
  }

  private toPublic(booking: DemoBooking, config: DemoBookingConfig): PublicBooking {
    return {
      id: booking.id,
      name: booking.name,
      email: booking.email,
      company: booking.company,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      timeZone: booking.timeZone,
      status: booking.status,
      meetUrl: booking.meetUrl,
      durationMinutes: config.durationMinutes,
    };
  }

  /** Best-effort — a mail failure never fails the booking the visitor made. */
  private async sendConfirmation(
    booking: DemoBooking,
    manageToken: string,
    kind: "booked" | "rescheduled" | "cancelled",
  ): Promise<void> {
    try {
      const { subject, html } = buildBookingEmail(booking, manageToken, kind, webUrl());
      const result = await this.email.send({ to: booking.email, subject, html });
      if (!result.delivered) {
        this.logger.warn(
          `demo-booking: ${kind} email for ${booking.id} was not delivered (${result.error ?? "no transport"})`,
        );
      }
    } catch (error) {
      this.logger.error(`demo-booking: ${kind} email for ${booking.id} threw — ${String(error)}`);
    }
  }
}

function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function webUrl(): string {
  return (process.env.WEB_URL || "https://www.routeflow.info").replace(/\/+$/, "");
}

function formatSlot(booking: DemoBooking): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: booking.timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(booking.startsAt);
  } catch {
    return booking.startsAt.toUTCString();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The email bodies. There is no template engine in this codebase — every other
 * sender builds HTML inline (see `email.service.ts#buildInvoiceEmail`).
 */
export function buildBookingEmail(
  booking: DemoBooking,
  manageToken: string,
  kind: "booked" | "rescheduled" | "cancelled",
  baseUrl: string,
): { subject: string; html: string } {
  const when = formatSlot(booking);
  const manageUrl = `${baseUrl}/book-a-demo/manage?token=${encodeURIComponent(manageToken)}`;
  const heading =
    kind === "cancelled"
      ? "Your RouteFlow demo is cancelled"
      : kind === "rescheduled"
        ? "Your RouteFlow demo has moved"
        : "Your RouteFlow demo is confirmed";
  const intro =
    kind === "cancelled"
      ? "We have cancelled the walkthrough below. If that was not intended, book a new time whenever suits."
      : kind === "rescheduled"
        ? "Your walkthrough has been moved to the time below. The calendar invitation has been updated."
        : "Thanks for booking a walkthrough. The details are below, and a calendar invitation is on its way from Google.";

  const meetRow =
    booking.meetUrl && kind !== "cancelled"
      ? `<tr><td style="padding:6px 0;color:#4c607a;">Video call</td><td style="padding:6px 0;"><a href="${escapeHtml(booking.meetUrl)}" style="color:#234f7e;">Join with Google Meet</a></td></tr>`
      : "";

  const action =
    kind === "cancelled"
      ? `<a href="${escapeHtml(baseUrl)}/book-a-demo" style="display:inline-block;padding:12px 22px;border-radius:26px;background:#10264d;color:#ffffff;text-decoration:none;font-weight:600;">Book another time</a>`
      : `<a href="${escapeHtml(manageUrl)}" style="display:inline-block;padding:12px 22px;border-radius:26px;background:#10264d;color:#ffffff;text-decoration:none;font-weight:600;">Reschedule or cancel</a>`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#eef3fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#152d51;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;padding:32px;">
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${heading}</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#4c607a;">${intro}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#4c607a;width:110px;">When</td><td style="padding:6px 0;font-weight:600;${kind === "cancelled" ? "text-decoration:line-through;" : ""}">${escapeHtml(when)}</td></tr>
      <tr><td style="padding:6px 0;color:#4c607a;">Company</td><td style="padding:6px 0;">${escapeHtml(booking.company)}</td></tr>
      ${meetRow}
    </table>
    <div style="margin:28px 0 8px;">${action}</div>
    <p style="margin:22px 0 0;font-size:12px;line-height:1.7;color:#738aa0;">Questions before then? Just reply to this email.</p>
  </div>
</body></html>`;

  return { subject: `${heading} — ${when}`, html };
}
