# Web landing 2026-11-03, train an (merge commit `f9f1a592ed`, range `fedb9c4fa7..f9f1a592ed`; train PR #4176, head `591729cb92`)

Web paths under `apps/web/` unless they start with `apps/api/`, `apps/mobile/` or `packages/`. Two members: #4172 `9c93f2ebec` (api side in `api/landing-2026-11-03-ao.md`), #4174 `e51f7c53ce`. No migration, no new env var. #4130 is not in this train. Tests are names only; they were not run for this note.

## #4174 `e51f7c53ce` the public site's phone pass (the owner's mobile-web ask)

Rule: nothing at 900 px wide and 500 px tall or more changes; the phone rules reach phones and short sideways windows only. No sentence changes meaning and no price changes.

- `public/site/css/mobile.css` (new, linked on nine pages with `media="(max-width:899.98px)"`): type balance, sign-up hint wrap fix, soft wheel-colour glows, heading rise on scroll. `scripts/sync-site-port.mjs` gains `css/mobile.css` in its file list.
- `public/site/graphics/rf-wheel-up.js` and `rf-wheel-up.css`, `public/site/css/home-up.css`: the live wheel runs on every height (the still stays only for no JavaScript); below 900 px, short and wider than tall, the wide layout with the words beside the wheel; `WASH_NARROW` (six glows) for a stage taller than 1.05 x its width; a turn of the phone rebuilds the wheel and keeps the place; a phone never draws a name under 11 px (a name that cannot fit is left out, the piece shows its icon).
- Pages with the link line: `public/site/{home,product,pricing,company,contact,security,getting-started,does-and-doesnt,data-in-and-out}.html`.
- Tests: `app/(marketing)/site-mobile-pass.static.test.ts` (new pins), `app/(marketing)/site-motion-always.static.test.ts` (the "falls back to the still under 500 px" pin replaced), `e2e/36-marketing-site.spec.ts` (T22 short-screen rows, T23 heading rows, names row).

## #4172 `9c93f2ebec`

- No web source. Mobile files `apps/mobile/lib/short-pick.ts` and `lib/stop-completion-key.ts` become re-exports; the web driver-stops screen (SA-1098 PR-2) will import `@routeflow/pricing` and `@routeflow/types` instead of copying.
