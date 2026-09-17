"use client";

import * as React from "react";
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Video,
} from "lucide-react";
import {
  Availability,
  Booking,
  BookingError,
  createBooking,
  fetchAvailability,
  formatDayHeading,
  formatSlotLong,
  formatSlotTime,
  timeZoneLabel,
  visitorTimeZone,
} from "../lib/demo-booking";
import { site } from "../lib/site";

/**
 * The live demo scheduler: real availability from the RouteFlow API (which
 * reads the team's Google Calendar), a real booking, a real Meet link.
 *
 * Replaces the design study's simulated widget. Two behaviours the study did
 * not have to get right, because it never talked to anything:
 *
 * - Availability is a read of a moving target, so the server re-checks the slot
 *   at write time and can refuse. A 409 sends the visitor back to the grid with
 *   the reason, and refreshes availability — it is never a dead end.
 * - When the calendar is unreachable the API returns no days at all rather than
 *   guessing. That is a different message from "this week is full", and the
 *   empty state says which.
 */

type Step = "slot" | "details" | "done";

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Monday-first column index for a `YYYY-MM-DD` key. */
function mondayIndex(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** First/last instant of the visible month, as a UTC-anchored calendar month. */
function monthBounds(cursor: Date) {
  const start = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  return { start, end };
}

export function DemoScheduler() {
  const [timeZone] = React.useState(visitorTimeZone);
  const [cursor, setCursor] = React.useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });
  const [availability, setAvailability] = React.useState<Availability | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<Step>("slot");
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [booking, setBooking] = React.useState<Booking | null>(null);

  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // `cursor` is the identity that matters; the Date object is recreated on each
  // month change, so key the effect on its month string instead.
  const cursorKey = monthKey(cursor);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    const { start, end } = monthBounds(cursor);
    // Never ask for slots in the past — the API clamps anyway, but this keeps
    // the request honest when the visitor is looking at the current month.
    const from = start.getTime() < Date.now() ? new Date() : start;

    fetchAvailability(from, end, timeZone, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setAvailability(result);
      })
      .catch((error: unknown) => {
        if (cancelled || (error as Error).name === "AbortError") return;
        setAvailability(null);
        // Always a fixed, generic message here — never `error.message`.
        // `DemoBookingService.getAvailability` never throws (every fail-closed
        // branch resolves with `days: []`), so anything landing in this catch
        // is a transport-level failure (network down, a routing mismatch, a
        // raw 500) with no curated, user-safe text behind it. A framework
        // 404's literal body is `Cannot GET /api/v1/public/demo-bookings/...`
        // — showing that verbatim on an unauthenticated public page leaks
        // internal API structure for zero benefit; "try again" is the only
        // actionable response regardless of the real cause.
        setLoadError("We could not load available times. Please try again.");
        void error;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cursorKey, timeZone, reloadKey, cursor]);

  const daysByKey = React.useMemo(() => {
    const map = new Map<string, AvailabilityDayShape>();
    for (const day of availability?.days ?? []) map.set(day.date, day);
    return map;
  }, [availability]);

  // Keep a selected date only while it still has slots — a refresh after a 409
  // can take it away.
  React.useEffect(() => {
    if (selectedDate && !daysByKey.has(selectedDate)) {
      setSelectedDate(null);
      setSelectedSlot(null);
    }
  }, [daysByKey, selectedDate]);

  const visibleCells = React.useMemo(() => buildMonthCells(cursor), [cursor]);
  const selectedDay = selectedDate ? daysByKey.get(selectedDate) : undefined;
  const zoneLabel = timeZoneLabel(timeZone);

  const atCurrentMonth = monthKey(cursor) === monthKey(new Date());

  function goToMonth(delta: number) {
    setCursor(
      (current) => new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)),
    );
    setSelectedDate(null);
    setSelectedSlot(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlot) return;
    const form = new FormData(event.currentTarget);
    const read = (field: string) => String(form.get(field) ?? "").trim();

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createBooking(
        {
          name: read("name"),
          email: read("email"),
          company: read("company"),
          phone: read("phone") || undefined,
          notes: read("notes") || undefined,
        },
        selectedSlot,
        timeZone,
      );
      setBooking(created);
      setStep("done");
      setTimeout(() => headingRef.current?.focus(), 0);
    } catch (error) {
      const message =
        error instanceof BookingError
          ? error.message
          : "We could not complete the booking. Please try again.";
      setFormError(message);
      // 409 = the slot went while they were typing. Send them back to a fresh
      // grid rather than letting them retry a time that is already gone.
      if (error instanceof BookingError && (error.status === 409 || error.status === 503)) {
        setStep("slot");
        setSelectedSlot(null);
        setReloadKey((key) => key + 1);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done" && booking) {
    return (
      <section className="glass booking-panel" aria-labelledby="booking-title">
        <div className="booking-done">
          <span className="g-tile">
            <Check aria-hidden="true" />
          </span>
          <h2 id="booking-title" tabIndex={-1} ref={headingRef}>
            You are booked in.
          </h2>
          <p>
            We have sent a confirmation to <strong>{booking.email}</strong>, and a calendar
            invitation is on its way from Google.
          </p>
        </div>
        <dl className="booking-summary">
          <dt>When</dt>
          <dd>{formatSlotLong(booking.startsAt, booking.timeZone)}</dd>
          <dt>How long</dt>
          <dd>{booking.durationMinutes} minutes</dd>
          {booking.meetUrl ? (
            <>
              <dt>Where</dt>
              <dd>
                <a className="g-link" href={booking.meetUrl} target="_blank" rel="noreferrer">
                  <Video aria-hidden="true" /> Join with Google Meet
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        <p className="g-note">
          Need a different time? The confirmation email has a link to reschedule or cancel.
        </p>
      </section>
    );
  }

  return (
    <section className="glass booking-panel" aria-labelledby="booking-title">
      <span className="g-tile">
        <CalendarDays aria-hidden="true" />
      </span>
      <h2 id="booking-title">Choose a demo time</h2>
      <p>
        {availability
          ? `Times shown in ${zoneLabel}. Each walkthrough runs ${availability.durationMinutes} minutes.`
          : "Select a date and time for a product walkthrough."}
      </p>

      <div className="booking-steps">
        <span aria-current={step === "slot" ? "step" : undefined}>1. Pick a time</span>
        <ChevronRight size={13} aria-hidden="true" />
        <span aria-current={step === "details" ? "step" : undefined}>2. Your details</span>
      </div>

      {step === "slot" ? (
        <>
          <div className="calendar-heading">
            <h3>{monthLabel(cursor)}</h3>
            <div className="calendar-nav">
              <button
                type="button"
                onClick={() => goToMonth(-1)}
                disabled={atCurrentMonth || loading}
                aria-label="Previous month"
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => goToMonth(1)}
                disabled={loading}
                aria-label="Next month"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="calendar-week" aria-hidden="true">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div
            className="calendar-grid"
            role="group"
            aria-label={`Available dates in ${monthLabel(cursor)}`}
          >
            {visibleCells.map((cell) =>
              cell.kind === "pad" ? (
                <span key={cell.key} aria-hidden="true" />
              ) : (
                <button
                  key={cell.key}
                  type="button"
                  className={[
                    daysByKey.has(cell.key) ? "available" : "",
                    selectedDate === cell.key ? "selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!daysByKey.has(cell.key)}
                  aria-pressed={selectedDate === cell.key}
                  aria-label={`${formatDayHeading(cell.key)}${
                    daysByKey.has(cell.key)
                      ? `, ${daysByKey.get(cell.key)!.slots.length} times available`
                      : ", no times available"
                  }`}
                  onClick={() => {
                    setSelectedDate(cell.key);
                    setSelectedSlot(null);
                  }}
                >
                  {cell.day}
                </button>
              ),
            )}
          </div>

          <hr className="g-rule" />

          {loading ? (
            <p className="slots-empty" role="status">
              Loading available times…
            </p>
          ) : loadError ? (
            <div className="g-alert" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>{loadError}</span>
            </div>
          ) : availability?.status === "unavailable" ? (
            // Distinct from "no free times below" (B499): the booking system
            // itself cannot serve real availability right now (unconfigured
            // or the calendar is unreachable), not a genuinely full calendar.
            <div className="g-alert" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>
                Online booking is temporarily unavailable. Email{" "}
                <a href={`mailto:${site.email}`}>{site.email}</a> and we will find a time that
                works.
              </span>
            </div>
          ) : !availability || availability.days.length === 0 ? (
            <p className="slots-empty" role="status">
              No times are available this month. Try the next month, or email us and we will find a
              slot that works.
            </p>
          ) : !selectedDay ? (
            <p className="slots-empty">Select a highlighted date to see its times.</p>
          ) : (
            <>
              <h3>{formatDayHeading(selectedDay.date)}</h3>
              <div className="time-slots" role="group" aria-label="Available times">
                {selectedDay.slots.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    className={selectedSlot === slot.startsAt ? "selected" : ""}
                    aria-pressed={selectedSlot === slot.startsAt}
                    onClick={() => setSelectedSlot(slot.startsAt)}
                  >
                    {formatSlotTime(slot.startsAt, timeZone)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="g-btn g-btn-primary g-btn-block"
                style={{ marginTop: 18 }}
                disabled={!selectedSlot}
                onClick={() => setStep("details")}
              >
                {selectedSlot
                  ? `Continue with ${formatSlotTime(selectedSlot, timeZone)}`
                  : "Choose a time"}
                <ArrowRight aria-hidden="true" />
              </button>
            </>
          )}

          {formError ? (
            <div className="g-alert" role="alert" style={{ marginTop: 18, marginBottom: 0 }}>
              <AlertCircle aria-hidden="true" />
              <span>{formError}</span>
            </div>
          ) : null}
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <dl className="booking-summary">
            <dt>Your slot</dt>
            <dd>{selectedSlot ? formatSlotLong(selectedSlot, timeZone) : ""}</dd>
          </dl>

          {formError ? (
            <div className="g-alert" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>{formError}</span>
            </div>
          ) : null}

          <div className="g-field">
            <label htmlFor="booking-name">Name</label>
            <input
              id="booking-name"
              name="name"
              className="g-input"
              autoComplete="name"
              required
              maxLength={100}
              placeholder="Alex Morgan"
            />
          </div>
          <div className="g-field">
            <label htmlFor="booking-email">Work email</label>
            <input
              id="booking-email"
              name="email"
              type="email"
              className="g-input"
              autoComplete="email"
              required
              maxLength={160}
              placeholder="alex@yourcompany.com"
              aria-describedby="booking-email-help"
            />
            <span className="g-help" id="booking-email-help">
              Your confirmation and calendar invitation go here.
            </span>
          </div>
          <div className="g-field">
            <label htmlFor="booking-company">Company</label>
            <input
              id="booking-company"
              name="company"
              className="g-input"
              autoComplete="organization"
              required
              maxLength={160}
              placeholder="Your distribution business"
            />
          </div>
          <div className="g-field">
            <label htmlFor="booking-phone">Phone (optional)</label>
            <input
              id="booking-phone"
              name="phone"
              type="tel"
              className="g-input"
              autoComplete="tel"
              maxLength={40}
            />
          </div>
          <div className="g-field">
            <label htmlFor="booking-notes">What should we cover? (optional)</label>
            <textarea
              id="booking-notes"
              name="notes"
              className="g-textarea"
              maxLength={1200}
              placeholder="Tell us about your orders, delivery routes, or current tools."
            />
          </div>

          <button type="submit" className="g-btn g-btn-primary g-btn-block" disabled={submitting}>
            {submitting ? "Booking…" : "Confirm this time"}
            {submitting ? null : <ArrowRight aria-hidden="true" />}
          </button>
          <div className="auth-meta">
            <button type="button" className="g-link" onClick={() => setStep("slot")}>
              <ChevronLeft aria-hidden="true" /> Pick a different time
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

interface AvailabilityDayShape {
  date: string;
  slots: Array<{ startsAt: string; endsAt: string }>;
}

type Cell = { kind: "pad"; key: string } | { kind: "day"; key: string; day: number };

/** Monday-first grid cells for the month `cursor` sits in. */
function buildMonthCells(cursor: Date): Cell[] {
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstKey = `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const cells: Cell[] = [];
  for (let pad = 0; pad < mondayIndex(firstKey); pad += 1) {
    cells.push({ kind: "pad", key: `pad-${pad}` });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({ kind: "day", key, day });
  }
  return cells;
}
