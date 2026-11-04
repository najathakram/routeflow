# Web landing 2026-11-03, train ap (merge commit `c8221d4b46`, range `f10b57ce34..c8221d4b46`; train PR #4182, head `be2f11f2ac`)

Web paths under `apps/web/` unless they start with `apps/api/`, `apps/mobile/` or `packages/`. Members: #4181 (docs), #4179 `6c76c10fa6`, #4173 `da8280c079` (api side in `api/landing-2026-11-03-aq.md`). No migration, no new env var. Tests are names only; they were not run for this note.

## #4173 `da8280c079` the driver's stop sheet on the web (SA-1098 PR-2)

Rule: the web never takes money and never derives what is left; it sends the stop's lines and shows the server's `remaining`.
- `app/(dashboard)/routes/my-runs/StopSheet.tsx` and `page.tsx`: Start route, Delivered (all of it or a short count per line), Refused with a reason, Skip, Undo, Finish route; the page keeps a finished run on screen (in memory only) until Undo or the driver leaves, so the last stop gets its Undo. `components/ArrivedStopSheet.tsx`, `lib/api/routes.ts`, `lib/driver-stop-copy.ts` (every server message mapped to a sentence, no raw server text on the sheet), `lib/stop-completion-key.ts` (one key per stop; `STOP_REOPENED` releases the key and keeps what was typed).
- Also in this member: the driver app banner `app/(dashboard)/dashboard/{DriverAppBanner,GetTheAppStrip,page}.tsx` with `lib/driver-app-link.ts`, `app/(auth)/login/page.tsx`, and `apps/web/Dockerfile`.
- Tests: `routes/my-runs/StopSheet.test.tsx`, `StopSheet.deliver.test.tsx`, `page.lifecycle.test.tsx`, `components/ArrivedStopSheet.test.tsx`, `lib/driver-stop-copy.test.ts`, `dashboard/DriverAppBanner.test.tsx`, `app/(auth)/login/page.test.tsx`.

## #4179 `6c76c10fa6` the founder's note, rewritten (owner's wording)

- `public/site/home.html` (`#founder`) and `company.html` (`#story`): same heading ("We built this with the people who use it every day."), nine paragraphs on both pages with a three-paragraph short version on the home phone view; no degree or university named. `css/home-up.css`, `css/home.css`, `css/site.css` (a nowrap rule scoped to the note). Sentences that no code backs are the owner's own words and are pinned word for word.
- Tests: `app/(marketing)/site-company-contact.static.test.ts` (same text on both pages, heading, no degree words, the checked sentences), `e2e/36-marketing-site.spec.ts` T25 (heading, gap and Read-the-rest rows).
