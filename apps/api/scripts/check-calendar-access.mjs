#!/usr/bin/env node
/**
 * Read-only check that the demo-booking Google Calendar credentials work.
 *
 * Mints a domain-wide-delegated access token, queries free/busy for the next
 * seven days, and prints what it finds. It creates, moves and deletes NOTHING —
 * safe to run against production at any time:
 *
 *   node apps/api/scripts/check-calendar-access.mjs
 *   railway run --service api node apps/api/scripts/check-calendar-access.mjs
 *
 * Setup it verifies: docs/runbooks/google-calendar-demo-booking-setup.md
 */
import { JWT } from "google-auth-library";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

function normalisePrivateKey(raw) {
  if (!raw) return "";
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n").trim();
}

function fail(message, hint) {
  console.error(`\n  FAILED  ${message}`);
  if (hint) console.error(`          ${hint}`);
  process.exit(1);
}

const saEmail = (process.env.GOOGLE_CALENDAR_SA_EMAIL ?? "").trim();
const saPrivateKey = normalisePrivateKey(process.env.GOOGLE_CALENDAR_SA_PRIVATE_KEY);
const impersonate = (process.env.GOOGLE_CALENDAR_IMPERSONATE ?? "").trim();
const calendarId = (process.env.GOOGLE_CALENDAR_ID ?? "primary").trim() || "primary";

console.log("RouteFlow demo booking — Google Calendar access check\n");
console.log(`  service account   ${saEmail || "(not set)"}`);
console.log(`  impersonating     ${impersonate || "(not set)"}`);
console.log(`  calendar          ${calendarId}`);
console.log(`  private key       ${saPrivateKey ? `${saPrivateKey.length} chars` : "(not set)"}`);

const missing = [
  !saEmail && "GOOGLE_CALENDAR_SA_EMAIL",
  !saPrivateKey && "GOOGLE_CALENDAR_SA_PRIVATE_KEY",
  !impersonate && "GOOGLE_CALENDAR_IMPERSONATE",
].filter(Boolean);
if (missing.length) {
  fail(
    `missing ${missing.join(", ")}`,
    "See step 4 of docs/runbooks/google-calendar-demo-booking-setup.md",
  );
}
if (!saPrivateKey.includes("BEGIN")) {
  fail(
    "GOOGLE_CALENDAR_SA_PRIVATE_KEY does not look like a PEM key",
    "Paste the JSON key's private_key value verbatim, including -----BEGIN PRIVATE KEY-----.",
  );
}

let token;
try {
  const client = new JWT({
    email: saEmail,
    key: saPrivateKey,
    scopes: SCOPES,
    subject: impersonate,
  });
  ({ token } = await client.getAccessToken());
} catch (error) {
  const message = String(error?.message ?? error);
  const hint = message.includes("unauthorized_client")
    ? "Domain-wide delegation is not authorized, or the scopes do not match exactly. Step 3 of the runbook — use the service account's 21-digit Unique ID, not its email."
    : message.includes("invalid_grant")
      ? "GOOGLE_CALENDAR_IMPERSONATE may not be a real mailbox, or the private key was mangled on paste."
      : undefined;
  fail(`could not mint a delegated token — ${message}`, hint);
}
if (!token) fail("Google returned an empty access token");
console.log("\n  OK      delegated access token minted");

const now = new Date();
const weekOut = new Date(now.getTime() + 7 * 86_400_000);
const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    timeMin: now.toISOString(),
    timeMax: weekOut.toISOString(),
    items: [{ id: calendarId }],
  }),
});

if (!response.ok) {
  const body = await response.text().catch(() => "");
  const hint =
    response.status === 403
      ? "Enable the Calendar API for the project — step 2 of the runbook."
      : response.status === 404
        ? `The impersonated user cannot see calendar "${calendarId}".`
        : undefined;
  fail(`freeBusy returned ${response.status} — ${body.slice(0, 300)}`, hint);
}

const body = await response.json();
const calendar = body.calendars?.[calendarId];
if (calendar?.errors) {
  fail(
    `the calendar reported an error: ${JSON.stringify(calendar.errors)}`,
    `Check that "${calendarId}" exists and ${impersonate} can read it.`,
  );
}

const busy = calendar?.busy ?? [];
console.log(`  OK      free/busy readable — ${busy.length} busy block(s) in the next 7 days\n`);
for (const block of busy.slice(0, 10)) {
  console.log(`          ${block.start}  →  ${block.end}`);
}
if (busy.length > 10) console.log(`          … and ${busy.length - 10} more`);

console.log("\nCalendar access is configured correctly. Nothing was created or changed.");
