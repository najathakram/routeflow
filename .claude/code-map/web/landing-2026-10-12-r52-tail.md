# Web landing 2026-10-12 (Release 5.2 tail)

Release 5.2 tail = range `7f9dfb180..96fc7351f` (16 non-merge commits; web source is touched by the card, the end-trial toast and an aria-label fix) on top of `landing-2026-10-12-r52.md`. Symbols read at the tip. Paths are under `apps/web/` unless noted. API: `api/landing-2026-10-12-r52-tail.md`; no mobile change. Tests are not indexed (5 web test files); pins named per section.

## R5.2 tail: the "Automatic locks" card on the super-admin billing page (row 381)

- `app/(platform-admin)/_components/AutoLocksCard.tsx` NEW `AutoLocksCard()`: loads `GET /platform-admin/config/auto-locks` via `superAdminClient`; status banner (`role="status"`, paused amber, on green), the tenants that would lock now (by id and kind), a collapsed "N locks held so far" list, one reason field (`aria-label` "Reason for the change") and one Pause or Unpause button.
- Same file, invariant: pausing is one click once the reason is valid; UNPAUSE first loads `.../auto-locks/preview` into an `AdminModal`, Cancel holds the initial focus, and `PATCH` fires only on the explicit confirm. The confirm is disabled while the preview is missing or failed. Failures show fixed copy, never the server's text. A missing status reads as paused.
- `lib/platform-admin/auto-locks.ts` NEW, pure: `isReasonValid` (trimmed 3..500, `REASON_MIN` / `REASON_MAX`), `autoLockBanner(state | null)`, `unpauseConfirmCopy(preview | null) -> {title, body, confirmLabel}`, `wouldLockRowText`, `kindLabel`, `AUTO_LOCK_KIND_LABELS`, `AUTO_LOCK_COPY` (fixed strings, incl. "Pausing never unlocks a tenant that is already locked").
- Same file: wire types come from `@routeflow/types` (`AutoLockState`, `AutoLockPreview`, `SetAutoLockPausedRequest`); a tenant is shown by id only.
- `app/(platform-admin)/admin/billing/page.tsx` mounts `<AutoLocksCard />` above the summary cards (the whole console is super admin only).
- Pins: `lib/platform-admin/auto-locks.test.ts`, `app/(platform-admin)/_components/AutoLocksCard.test.tsx` (preview first, Cancel writes nothing; its helper waits for the labelled field before typing).

## R5.2 tail: end-trial toast knows a recorded request (row 381)

- `app/(dashboard)/settings/billing/end-trial-toast.ts` NEW `endTrialToast(result: unknown) -> {title, description?}`: `{ cancelled: "trial_recorded" }` (the server held the lock while automatic locks are paused) -> "Request received" with a neutral line that the workspace stays as it is for now; any other or odd body -> "Trial ended". Reads the body defensively.
- `app/(dashboard)/settings/billing/page.tsx` End-trial confirm `onSuccess: (data) => toast(endTrialToast(data))` (was a fixed "Trial ended"). Pin: `end-trial-toast.test.ts`.

## R5.2 tail: smaller changes

- `lib/handover-stamp.staff-only.static.test.ts` is spec-only: made path-separator agnostic.
- `packages/types/read-only-copy.ts` gained `SUSPENDED_SENTENCE` / `CANCELLED_SENTENCE` for the API's Connect refusal; no web source reads them yet (only `lib/read-only-copy.test.ts` touches them).
