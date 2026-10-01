# F12-PASSWORD-RESET

## RFs addressed

| RF     | Sev | Status | Files                                                                                                                                                                                                                                                      | Commit                                          | Test added                                  | Migration?            |
| ------ | --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- | --------------------- |
| RF-018 | P1  | ✅     | `apps/api/src/auth/auth.service.ts`, `auth.controller.ts`, `dto/request-password-reset.dto.ts`, `dto/reset-password.dto.ts`, `apps/mobile/app/(auth)/forgot-password.tsx`, `apps/mobile/app/(auth)/reset-password.tsx`, `apps/mobile/app/(auth)/login.tsx` | `fix(auth): RF-018 self-service password reset` | `src/auth/password-reset.spec.ts` (8 tests) | ⚠️ MIGRATION REQUIRED |

## Notes / blockers

### MIGRATION REQUIRED — apply manually to Railway DB

File: `apps/api/prisma/migrations/20260501300000_add_password_reset_token/migration.sql`

Run against Railway Postgres before deploying this commit:

```sql
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
ALTER TABLE "PasswordResetToken"
    ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

### Email delivery

- Email provider: **Resend** (already wired via `RESEND_API_KEY` env var).
- If `RESEND_API_KEY` is absent the email is logged to console (existing fallback in `EmailService`).
- No new env vars needed.

### Throttling

- Both endpoints throttled at **5 requests per 15 min per IP** via `@Throttle`.

### Token security

- 32-byte cryptographically random raw token (`crypto.randomBytes(32)`).
- Only the SHA-256 hash is stored in DB — raw token is never persisted.
- Token expires in 15 minutes; single-use (`usedAt` set on consumption).
- On successful reset all refresh tokens for the user are deleted (force logout).

## User-visible proof of fix

1. **Staff login screen** — "Forgot?" link now navigates to `/(auth)/forgot-password` instead of showing a "coming soon" alert.
2. **Forgot Password screen** — email input + "Send reset link" button. On submit always shows: "Check your email — if that address is registered you'll receive a reset link shortly."
3. **Reset Password screen** — opened via deep-link `?token=<raw>`. New password + confirm fields. On success: "Password reset — please log in" state with a "Go to sign in" button that redirects to `/(auth)/login`.
4. **API**: `POST /auth/request-password-reset` (200 always) and `POST /auth/reset-password` (200 or 400 on bad/expired/used token).
