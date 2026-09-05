/**
 * recover-calendar-day.cjs — recovers the calendar day behind a
 * `CustomerAuthorization.expiresAt` row damaged by the pre-F25 mobile-operator
 * licence form (bug B91's writer half).
 *
 * THE RULE (device-zone agnostic — read this before changing anything).
 * The damaged rows were written as ``new Date(`${day}T23:59:59`)`` — a LOCAL
 * wall-clock instant in the WRITING DEVICE's timezone, which is unrelated to
 * the tenant's configured timezone. Recovering the day through
 * `TenantConfig.timezone` therefore lands on the wrong day (one day late)
 * whenever the device sat west of the tenant zone, so the tenant zone MUST NOT
 * be used here and this function takes no `timeZone` argument.
 *
 * What the stored instant does identify unambiguously is the intended day
 * itself: for a device offset `o`, the stored value is `day 23:59:59 − o`, so
 * for every `o` from UTC−12:00 to UTC+11:59:59 the stored UTC time-of-day is
 * either 12:00:00–23:59:59 on the intended day (o ≥ 0) or 00:00:00–11:59:59 on
 * the FOLLOWING UTC day (o < 0). Hence: a UTC time-of-day before noon means the
 * intended day is the previous UTC day; noon or later means it is the UTC day
 * itself.
 *
 * Returns "YYYY-MM-DD", or `null` when `storedIso` is unparseable or is ALREADY
 * a UTC-midnight row (time-of-day exactly 00:00:00.000) — such a row is the
 * correct storage convention and must never be "recovered" into a shifted day.
 *
 * Shared by `scripts/repair-f25-licence-dates.mjs` (no cross-package import
 * exists between `scripts/*.mjs` and `apps/api/src` today).
 */
function recoverCalendarDay(storedIso) {
  const d = new Date(storedIso);
  if (Number.isNaN(d.getTime())) return null;
  const isUtcMidnight =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  if (isUtcMidnight) return null; // already correct — skip, never "recover" a good row
  const utcDay = d.toISOString().slice(0, 10);
  if (d.getUTCHours() >= 12) return utcDay;
  const [year, month, day] = utcDay.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Classifies one planned repair row for the two hold-back gates in
 * `scripts/repair-f25-licence-dates.mjs`. Pure, and takes the clock as an
 * argument, so the script can re-classify against a FRESH `now` taken AFTER
 * the operator prompt returns rather than trusting the plan-time snapshot —
 * an `--execute` run whose plan and writes straddle a UTC midnight would
 * otherwise write a currently-valid licence into the past ungated.
 *
 *   • `expiringNow` — the row is valid at `nowMs` but its repaired value is
 *     already in the past, so the write itself expires the licence
 *     (`authorization-expiry.service.ts` flips it to EXPIRED and notifies the
 *     customer; `authorization-guard.service.ts` then blocks regulated sales).
 *     Held back unless `--allow-expiring-rows` is passed.
 *   • `farEast` — the stored UTC time-of-day falls in [09:00:00, 12:00:00),
 *     the band into which a device at UTC+12…+14 writes its local 23:59:59.
 *     The before-noon rule above rolls those back one UTC day, which is ONE
 *     DAY EARLY for such a device — and is indistinguishable from a genuine
 *     previous-day write by a UTC−10…−12 device, which the same rule recovers
 *     correctly. Ambiguous either way, so held back unless
 *     `--allow-far-east-rows` is passed.
 *
 * `nowMs` is a millisecond epoch (`Date.now()`), never a Date, so a caller
 * cannot accidentally hand in a stale object it captured earlier.
 */
function classifyRepairRow(storedIso, afterIso, nowMs) {
  const before = new Date(storedIso);
  const after = new Date(afterIso);
  const parsable = !Number.isNaN(before.getTime()) && !Number.isNaN(after.getTime());
  const hour = parsable ? before.getUTCHours() : -1;
  return {
    expiringNow: parsable && before.getTime() >= nowMs && after.getTime() < nowMs,
    farEast: hour >= 9 && hour < 12,
  };
}

module.exports = { recoverCalendarDay, classifyRepairRow };
