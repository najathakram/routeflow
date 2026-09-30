# Google Calendar setup for demo booking

One-time setup that lets the RouteFlow API read availability from, and write bookings to, the
`admin@routeflow.info` Google Calendar. Until these steps are done the booking page renders but
reports no availability — the API fails closed rather than inventing slots.

`routeflow.info` is a Google Workspace domain (MX = `aspmx.l.google.com`), so this uses a
**service account with domain-wide delegation**: no refresh token to rotate, no consent screen
to keep published, and no human session the booking flow depends on.

> Everything below is done by the owner. The assistant cannot create Google Cloud resources or
> change Workspace admin settings.

## 1. Create the service account (Google Cloud console)

Use the existing `routeflow-506615` project — the same one that holds the Google Sign-In client.

1. <https://console.cloud.google.com/iam-admin/serviceaccounts?project=routeflow-506615> → **Create service account**
2. Name: `routeflow-demo-booking`. Skip the optional role and user-access steps — domain-wide
   delegation grants the access, not an IAM role.
3. Open the new account → **Keys** → **Add key** → **Create new key** → **JSON**. The file
   downloads once and cannot be re-downloaded; keep it out of the repo (`local-assets/` is
   gitignored).
4. On the account's **Details** tab, copy the **Unique ID** (a 21-digit number). That is the
   OAuth client ID delegation needs in step 3.

## 2. Enable the Calendar API

<https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=routeflow-506615>
→ **Enable**. Without this every call returns `403 accessNotConfigured`.

## 3. Authorize domain-wide delegation (Workspace admin console)

Signed in as `admin@routeflow.info`:

1. <https://admin.google.com/ac/owl/domainwidedelegation> → **Add new**
2. **Client ID**: the 21-digit Unique ID from step 1.4
3. **OAuth scopes** (comma-separated, exactly these two):
   ```
   https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/calendar.readonly
   ```
4. **Authorize**

`calendar.readonly` backs the free/busy availability query; `calendar.events` creates, moves and
cancels the booking. Neither grants access to any other user's calendar — impersonation is pinned
to `GOOGLE_CALENDAR_IMPERSONATE` below.

Delegation changes can take a few minutes to propagate.

## 4. Set the Railway environment variables (api service)

From the downloaded JSON key:

| Variable                         | Value                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| `GOOGLE_CALENDAR_SA_EMAIL`       | the JSON's `client_email`                                          |
| `GOOGLE_CALENDAR_SA_PRIVATE_KEY` | the JSON's `private_key`, **verbatim including the `\n` escapes**  |
| `GOOGLE_CALENDAR_IMPERSONATE`    | `admin@routeflow.info`                                             |
| `GOOGLE_CALENDAR_ID`             | `primary` (or a dedicated calendar's ID — see below)               |
| `DEMO_BOOKING_TOKEN_SECRET`      | a fresh 32+ byte random string — signs the cancel/reschedule links |

`GOOGLE_CALENDAR_SA_PRIVATE_KEY` is the one that goes wrong: paste the JSON string's contents
exactly as they appear in the file (one line, with literal `\n` two-character sequences). The
service normalises those back to real newlines. Do not re-wrap it across lines and do not strip
the `-----BEGIN PRIVATE KEY-----` header.

**Using a dedicated calendar instead of `primary`** is worth it if you don't want demo bookings
mixed into the admin account's own calendar: create one in Google Calendar as `admin@routeflow.info`,
open its settings, and copy the **Calendar ID** into `GOOGLE_CALENDAR_ID`. Availability is then
computed from that calendar alone — anything on the admin account's primary calendar will no
longer block a slot, which is usually not what you want. Prefer `primary` unless you have a
reason.

## 5. Verify

```bash
node apps/api/scripts/check-calendar-access.mjs
```

Reads the same env vars the API does, mints a delegated token, queries free/busy for the next
seven days, and prints the busy blocks it found. It creates nothing. Run it with
`railway run --service api node apps/api/scripts/check-calendar-access.mjs` to verify the
deployed configuration rather than a local one.

## Failure modes

| Symptom                        | Cause                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized_client`          | Delegation not authorized, or the scopes in step 3 don't match exactly. Re-check the Client ID is the **Unique ID**, not the service account email. |
| `403 accessNotConfigured`      | Calendar API not enabled (step 2).                                                                                                                  |
| `invalid_grant`                | `GOOGLE_CALENDAR_IMPERSONATE` is not a real mailbox in the domain, or the private key was mangled on paste.                                         |
| `404 notFound` on the calendar | `GOOGLE_CALENDAR_ID` names a calendar the impersonated user cannot see.                                                                             |
| Page shows no slots, no error  | Expected when the env vars are absent — the API fails closed. Check the `api` logs for `demo-booking: calendar not configured`.                     |

## Rotating the key

Create a second key in step 1.3, update the two Railway variables, redeploy, confirm step 5, then
delete the old key in the console. The service reads credentials per request from env, so there is
no cache to clear.
