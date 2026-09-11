# Mandatory dependencies

External services RouteFlow cannot function without, how their health is monitored, and how to
restore each one. No secrets, UUIDs, or client ids live in this file — see the environment
variable names in each app's `.env.example` and read actual values from the environment or
Railway, never from here.

## Google OAuth (sign-in)

Google sign-in backs three doors: the platform-admin console, tenant operator/staff login, and
the mobile app. It is provisioned in the platform GCP project under OAuth brand
"RouteFlow", on a Web-application OAuth client. The API sends exactly two redirect URIs, the literal
values of `GOOGLE_REDIRECT_URI_TENANT` and `GOOGLE_REDIRECT_URI_PLATFORM` on the Railway `apps/api`
service (fallbacks when unset: `https://<RAILWAY_PUBLIC_DOMAIN>/api/v1/auth/google/callback` and
`https://<RAILWAY_PUBLIC_DOMAIN>/api/v1/platform-admin/auth/google/callback`) — see
`resolveRedirectUri` in `apps/api/src/auth/google-oauth.service.ts`. Those two exact strings must
be registered as Authorized redirect URIs on the OAuth client; any legacy host variants already
registered may stay but are not required. Registering a web-domain callback URI instead produces
`redirect_uri_mismatch`, which the monitor reports by that name.
The client id/secret are read by `apps/api` only, from `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI_TENANT`, and `GOOGLE_REDIRECT_URI_PLATFORM` in `apps/api/.env.example` —
**the secret is set by the owner only**; no one else should hold or paste it. Where a standby
client exists it is provisioned the same way, in the same GCP project, and swapped in only by
updating the env vars — never by editing code.

**Break-glass**: if Google sign-in is down for any door, every affected user can still sign in
with a password. The platform-admin super-admin account always has a password login path — use
it to operate while OAuth is restored. This was the actual recovery path for OPS-23,
**discovered 2026-09-11**: the OAuth client was gone and Google's consent page returned
`deleted_client` on every door. How long it had been broken, and why the client disappeared, is
unknown — nothing tested it, so there is no signal to date the break from. Do not repeat a
deletion date or a cause anywhere; the monitor below exists so the next one is dated by a red
run instead of a guess.

### Restoring the client (what OPS-23 actually required)

A deleted OAuth client cannot be un-deleted, and if the **brand** (OAuth consent screen app) was
deleted too, no client can be created under it — the console refuses. The restore is therefore a
rebuild, in the platform GCP project:

1. **Create a new brand / consent screen** — app name "RouteFlow", user type **External**, support
   and developer contact = the ops mailbox (not a personal address).
2. **Create a new OAuth client** of type **Web application** under that brand.
3. **Add the Authorized redirect URIs** — the literal values of `GOOGLE_REDIRECT_URI_PLATFORM` and
   `GOOGLE_REDIRECT_URI_TENANT` as set on the Railway `apps/api` service, **plus** the same two
   callback paths on the alternate Railway public domain (the `…-d504` host) and on
   `http://localhost:3000` for local development. Read the values from the Railway environment —
   never from this file.
4. **Set `GOOGLE_CLIENT_ID`** on the Railway `api` **and** `web` services with `--skip-deploys` so
   the services are not restarted with a half-updated pair.
5. **The OWNER pastes `GOOGLE_CLIENT_SECRET`** on both services — that write is what triggers the
   redeploy. No one else holds or pastes the secret.
6. **Publish the app** — Google Auth Platform → Audience → _Publish app_. While the audience is
   **Testing**, only explicitly listed test users can sign in; everyone else is refused.
7. **Verify**: `npm run smoke:google` against production (`SMOKE_BASE_URL` = the prod API) must go
   green on both doors before the dependency counts as restored.

### The monitor (OPS-23 hardening, DECIDE-29)

Two automated checks now watch this dependency:

- **Every deploy** — `scripts/post-deploy-check.mjs` section "Google sign-in doors" probes the
  platform-admin door and the tenant door, follows each consent URL, and fails the deploy check
  if either door leads to a Google error page (deleted/invalid client, redirect URI mismatch,
  `access_denied`, or Google's own "Access blocked" page) — or to any page that does not
  positively identify itself as a Google sign-in surface (`unexpected_page`) — instead of a real
  `accounts.google.com` consent screen.
  `scripts/smoke.mjs` runs the same unauthenticated probe.
- **Every six hours** — `.github/workflows/google-signin-monitor.yml` runs
  `scripts/google-signin-monitor.mjs` against production on a cron schedule (and on manual
  dispatch), independent of any deploy. A red run means Google sign-in has been broken for up to
  6 hours without anyone deploying — check the workflow's run log first.

**Limits**: the probe is **unauthenticated** — it stops at the consent screen and never signs in.
So it detects only the **client/redirect configuration**: a deleted or invalid client, a missing or
wrong redirect URI, a door that no longer reaches Google. It canNOT detect a per-user problem —
a **Testing**-audience restriction (the app unpublished, so only listed test users are admitted),
a blocked or suspended individual account, or a consent screen a real user would be refused at.
Those still need a human to try a real sign-in.

**Reading a red run**: the failing check names the door (`platform-admin` or `tenant`) and a
`reason`. The reason is read from the final URL's decoded `authError` parameter first and the
consent page body second — Google's error document is ~800 KB and names the cause only in that
parameter.

| `reason`                     | What it means / first move                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleted_client`             | The OAuth client no longer exists — rebuild it (see "Restoring the client" above), then set the env vars on `api` + `web`.                                                   |
| `invalid_client`             | The client id is wrong or the client is disabled — check `GOOGLE_CLIENT_ID` on Railway before touching GCP.                                                                  |
| `redirect_uri_mismatch`      | A redirect URI was changed or removed on the client — re-add the exact `GOOGLE_REDIRECT_URI_*` values. (Now reachable: read from the URL.)                                   |
| `access_denied`              | Google refused the request — typically the app is back on the **Testing** audience, or consent was blocked. Check Audience → Publish status.                                 |
| `unexpected_page`            | The flow ended somewhere with no positive sign-in signal (an interstitial, a redirect elsewhere). Open the printed page path by hand.                                        |
| `oauth_error` / `wrong_host` | Google reported an error with no recognised name, or the flow left `accounts.google.com` entirely.                                                                           |
| `door_http_<status>`         | RouteFlow's own `/auth/google` door answered completely but unusably (5xx, or 2xx with no `url`) — the OAuth client is not implicated. Check the `apps/api` deploy and logs. |
| `not_configured`             | The `GOOGLE_*` env vars are missing. On production that is itself the failure; locally it is expected and skipped.                                                           |
| `timeout` / `network`        | Usually transient — rerun before escalating.                                                                                                                                 |

Failure lines print the final page as **origin + pathname only**; the query string is withheld
because it carries the OAuth client id and state. In every case, tell affected users to use the
password break-glass login while the client is restored.

The check makes no attempt to actually sign in — it only confirms each door still reaches a live,
correctly configured Google consent screen, so it needs no credentials and never touches a real
account.

## Apex DNS (`routeflow.info`)

The bare apex domain's DNS record status is checked opportunistically by the same monitor
(`checkApexDns` in `scripts/lib/google-signin-check.mjs`) and reported as a warning, not a hard
failure, until the owner fixes the record — set `SMOKE_APEX_REQUIRED=1` to make it a hard gate
once the record is confirmed healthy. A DNS lookup failure here does not by itself mean Google
sign-in or the site is down; check the production URLs directly first.

## Restoring a mandatory dependency, in general

1. Confirm the break-glass path (password login, or the equivalent for whichever dependency is
   down) is available so users are not fully blocked while you fix the root cause.
2. Restore the dependency in its own console (GCP, DNS registrar, etc.) — never by patching
   RouteFlow's code around it.
3. Update only environment variable values (never code) on Railway for `apps/api`, then
   redeploy.
4. Re-run the relevant monitor (`node scripts/google-signin-monitor.mjs` for Google, or trigger
   the workflow via `workflow_dispatch`) and confirm it goes green before considering the
   dependency restored.
