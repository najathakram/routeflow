# Runbook: platform transactional email (Google Workspace SMTP)

Owner ruling 2026-09-16: RouteFlow's platform-level transactional email (sign-up/verification,
account changes, invoices, notifications) runs on **Google Workspace SMTP**, not a third-party ESP
— RouteFlow's mail is already on Google. Resend remains supported as an alternative platform
transport (used only when `SMTP_HOST` is unset) and per-tenant SMTP (Settings → Email) is
unaffected either way — see `apps/api/src/email/email.service.ts` and bug **B452**.

This is an **owner-only setup** — it needs access to the `routeflow.info` Google Workspace admin
console and DNS. No real Google credentials are ever committed to this repo; only environment
variable **names** live here (`apps/api/.env.example`).

## 1. Create the mailbox

1. In the Google Workspace admin console (admin.google.com), go to **Directory → Users → Add new
   user**. Create **`noreply@routeflow.info`** as a real user (licensed mailbox) — **not** a group
   or an alias. An alias cannot authenticate over SMTP; it must be a user with its own login.
2. Sign in as that user once (or use "Sign in as user") to accept the terms and set a real
   (throwaway) password — SMTP auth uses an App Password, not this one, but the account must be
   activated first.

## 2. Enable 2-Step Verification + generate an App Password

1. As `noreply@routeflow.info`, go to **myaccount.google.com/security** and turn on **2-Step
   Verification** (required — Google only issues App Passwords to accounts that have it on).
2. Go to **myaccount.google.com/apppasswords**, create an app password named `RouteFlow SMTP`,
   and copy the 16-character code. This is the value for `SMTP_PASS` below — store it only in
   Railway's environment, never in the repo.

## 3. Confirm SPF, turn on DKIM, add DMARC

Deliverability for a Workspace mailbox depends on all three being correct on `routeflow.info`'s
DNS:

1. **SPF** — should already be published for Workspace. Confirm the TXT record on `routeflow.info`
   contains `include:_spf.google.com`, e.g.:
   ```
   v=spf1 include:_spf.google.com ~all
   ```
   If RouteFlow also sends via another platform transport (e.g. Resend) from the same root domain,
   that provider's `include:` must be added to this **same** record — SPF only checks the first
   record found, a second `v=spf1` TXT record is invalid and breaks alignment for everyone.
2. **DKIM** — in the admin console, go to **Apps → Google Workspace → Gmail → Authenticate email**,
   generate a key for `routeflow.info`, publish the shown TXT record, then click **Start
   authentication**. Without this, mail from a Workspace mailbox is far more likely to land in spam
   at large recipients (Gmail, Outlook).
3. **DMARC** — add a TXT record at `_dmarc.routeflow.info`:
   ```
   v=DMARC1; p=quarantine; rua=mailto:dmarc@routeflow.info
   ```
   `p=quarantine` (not `reject`) is the safer starting policy — it asks receiving mail servers to
   spam-folder a failing message rather than bounce it outright, while `rua` collects aggregate
   reports to `dmarc@routeflow.info` so failures are visible before tightening to `p=reject`.

## 4. Railway `api` service environment

Set these on the `api` service (Railway dashboard → Variables, or `railway variables set`):

| Variable      | Value                                         |
| ------------- | --------------------------------------------- |
| `SMTP_HOST`   | `smtp.gmail.com`                              |
| `SMTP_PORT`   | `587`                                         |
| `SMTP_SECURE` | `false` (587 uses STARTTLS, not implicit TLS) |
| `SMTP_USER`   | `noreply@routeflow.info`                      |
| `SMTP_PASS`   | the 16-character App Password from step 2     |
| `EMAIL_FROM`  | `RouteFlow <noreply@routeflow.info>`          |

Leave `RESEND_API_KEY` unset (or remove it) — `EmailService`'s constructor selects platform SMTP
over Resend whenever `SMTP_HOST` is set, and never runs both for the same send. If a Resend key is
still set from before this change, it is simply ignored while `SMTP_HOST` is present.

## 5. Verify without sending anything

Before (or after) deploying, run the read-only diagnostic against the real environment:

```bash
railway run --service api node apps/api/scripts/check-email-sender.mjs
```

It prints the resolved provider (should say `smtp`) and sender, then does a real
`transporter.verify()` handshake — connects and authenticates — **without sending any mail**.
`OK` means the mailbox is ready; a failure prints the raw SMTP error plus common Gmail-specific
causes (wrong password vs. App Password, 2-Step Verification not yet on).

## 6. Daily volume ceiling

A single Google Workspace mailbox is capped at roughly **2,000 sends/day** (Google's standard
Workspace sending limit; the exact number varies slightly by edition and account age). This is a
**per-mailbox** cap — `noreply@routeflow.info` carries every platform-level transactional send
across every tenant, so it's the whole platform's ceiling, not one tenant's. If the email audit
(bug B452 companion report) projects platform volume approaching that — many tenants each sending
several invoices/notifications a day — this setup needs to move to either:

- A dedicated ESP (Resend, already wired as the alternative platform transport — just set
  `RESEND_API_KEY` and unset `SMTP_HOST`), or
- Google Workspace's higher-volume outbound relay (a `smtp-relay.gmail.com` configuration, which
  has its own separate setup and per-domain daily limits well above the single-mailbox cap).

Per-tenant SMTP sends (a tenant's own mailbox, configured under Settings → Email) are **not**
subject to this cap — they use the tenant's own provider and quota, independent of the platform
mailbox.

## Local proof (no real mailbox involved)

`docker-compose.yml`'s `app` profile runs a `mailpit` container (SMTP `:1025`, web UI `:8025`) and
points the `api` service's `SMTP_HOST`/`SMTP_PORT` at it — the exact same code path as prod, just
against a local catch-all instead of Google. See `local-assets/email-proof-2026-09-16/` for a
screenshot of a real send (buyer invite) captured by Mailpit during this change's verification.
