// apps/api/scripts/demo-bookings.mjs
//
// Operator visibility and undo for the public demo-booking feature (review finding 5): the
// booking widget's only public write path is create/reschedule/cancel by the visitor's own
// manage token, and there is no admin UI or endpoint yet. Without this script a bad booking
// (spam, a mistyped slot, a no-show the team wants to free up) sits on the calendar and in the
// partial-unique-index-guarded table forever, with only the booker able to remove it.
//
// NOT tenant-scoped — DemoBooking carries no tenantId (see the model's schema comment), so
// there is no `assertTestTenant`/`--live-tenant-override` gate to run: this touches one global,
// non-tenant table, the same shape as `report-addon-gate-blast-radius.mjs`'s read-only-by-design
// posture, except `--cancel` is a real write, gated by DRY-RUN-BY-DEFAULT instead.
//
// SAFETY:
//   - `--list` is read-only, always allowed.
//   - `--cancel <id>` without `--apply` prints what WOULD happen and writes nothing.
//   - `--cancel <id> --apply` is the only write path: sets status=CANCELLED, and — same posture
//     as the API's own cancel() — best-effort deletes the Google Calendar event if the booking
//     has one, logging (not failing) on a calendar error.
//   - Never touches `manageTokenHash` — this script can identify and cancel a booking by its
//     opaque row id, but can never mint or read the booking's own manage token.
//   - `statement_timeout` is set before any query; the connection is always closed in `finally`.
//
// Usage:
//   node apps/api/scripts/demo-bookings.mjs --list                       # upcoming, confirmed
//   node apps/api/scripts/demo-bookings.mjs --list --all                 # every status, any date
//   node apps/api/scripts/demo-bookings.mjs --cancel <id>                # dry run — prints only
//   node apps/api/scripts/demo-bookings.mjs --cancel <id> --apply [--reason "..."]
//   railway run --service postgres node apps/api/scripts/demo-bookings.mjs --list   # against prod

import { createRequire } from "module";
import { resolveDatabaseUrl, redactUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

// Standalone Calendar delete — deliberately NOT importing the compiled Nest
// service (no other script in this repo imports src/dist app code; every one
// is self-contained). Same auth shape as check-calendar-access.mjs: a
// service-account JWT with domain-wide delegation, minted fresh per run.
async function deleteCalendarEvent(eventId) {
  const { JWT } = require("google-auth-library");
  const saEmail = (process.env.GOOGLE_CALENDAR_SA_EMAIL ?? "").trim();
  const saPrivateKey = (process.env.GOOGLE_CALENDAR_SA_PRIVATE_KEY ?? "")
    .replace(/\\n/g, "\n")
    .trim();
  const impersonate = (process.env.GOOGLE_CALENDAR_IMPERSONATE ?? "").trim();
  const calendarId = (process.env.GOOGLE_CALENDAR_ID ?? "primary").trim() || "primary";
  if (!saEmail || !saPrivateKey || !impersonate) {
    throw new Error(
      "GOOGLE_CALENDAR_SA_EMAIL / GOOGLE_CALENDAR_SA_PRIVATE_KEY / GOOGLE_CALENDAR_IMPERSONATE " +
        "not set — cannot remove the calendar event. The row is already cancelled; remove the " +
        "event by hand in Google Calendar.",
    );
  }

  const client = new JWT({
    email: saEmail,
    key: saPrivateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    subject: impersonate,
  });
  const { token } = await client.getAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const body = await response.text().catch(() => "");
    throw new Error(`Calendar DELETE failed with ${response.status}: ${body.slice(0, 200)}`);
  }
}

function parseArgs(argv) {
  const args = { list: false, all: false, cancel: null, apply: false, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--cancel") args.cancel = argv[++i];
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--reason") args.reason = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`demo-bookings.mjs — operator visibility and undo for public demo bookings

  --list                  Upcoming CONFIRMED bookings (default view)
  --list --all            Every booking, any status, any date
  --cancel <id>            Dry run: show what cancelling <id> would do
  --cancel <id> --apply    Cancel it for real (status + best-effort calendar delete)
    --reason "<text>"      Optional operator note stored on the row

  DATABASE_URL (or the Railway proxy vars under 'railway run --service postgres') is required.`);
}

function formatRow(row) {
  const when = new Date(row.startsAt).toISOString();
  const status = row.status.padEnd(9);
  return `${row.id}  ${status}  ${when}  ${row.name} <${row.email}>  ${row.company}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.list && !args.cancel)) {
    printHelp();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET statement_timeout = 10000");

    if (args.list) {
      const where = args.all ? "" : `WHERE status = 'CONFIRMED' AND "startsAt" >= now()`;
      const { rows } = await client.query(
        `SELECT id, name, email, company, "startsAt", status, "googleEventId"
         FROM "DemoBooking" ${where}
         ORDER BY "startsAt" ASC
         LIMIT 200`,
      );
      if (rows.length === 0) {
        console.log(args.all ? "No demo bookings." : "No upcoming confirmed demo bookings.");
      } else {
        console.log(`${rows.length} booking(s):\n`);
        for (const row of rows) console.log(formatRow(row));
      }
      return;
    }

    // --cancel
    const { rows } = await client.query(
      `SELECT id, name, email, company, "startsAt", status, "googleEventId"
       FROM "DemoBooking" WHERE id = $1`,
      [args.cancel],
    );
    const booking = rows[0];
    if (!booking) {
      console.error(`No demo booking with id ${args.cancel}`);
      process.exitCode = 1;
      return;
    }
    if (booking.status === "CANCELLED") {
      console.log(`${formatRow(booking)}\nAlready cancelled — nothing to do.`);
      return;
    }

    console.log(`${args.apply ? "Cancelling" : "Would cancel"}:\n${formatRow(booking)}`);
    if (!args.apply) {
      console.log("\nDry run — no changes made. Re-run with --apply to cancel for real.");
      return;
    }

    await client.query(
      `UPDATE "DemoBooking"
       SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = $2, "updatedAt" = now()
       WHERE id = $1`,
      [
        args.cancel,
        args.reason ? `[operator] ${args.reason}` : "[operator] cancelled via demo-bookings.mjs",
      ],
    );
    console.log("Row updated to CANCELLED.");

    if (booking.googleEventId) {
      try {
        await deleteCalendarEvent(booking.googleEventId);
        console.log(`Calendar event ${booking.googleEventId} removed.`);
      } catch (error) {
        // Same posture as DemoBookingService#cancel: the row is the source of
        // truth, a stale calendar entry is a smaller problem than crashing an
        // otherwise-successful cancel.
        console.error(
          `Cancelled the row, but could not remove calendar event ${booking.googleEventId}: ${error.message}\n` +
            `Remove it by hand in Google Calendar if it's still showing.`,
        );
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    throw new Error(message.replace(databaseUrl, redactUrl(databaseUrl)));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
