# Web landing 2026-11-03, train ak (merge commit `d833210811` via #4163, range `9dfd480c30..d833210811`; train PR #4163, head `832a7f8489`)

Web paths under `apps/web/` unless they start with `apps/api/`. Three members: #4153 `4b88eb717d`, #4158 `f65657e48c`, #4159 `344ff8c04c` (api side in `api/landing-2026-11-03-ak.md`). No migration, no new env var. Tests are names only; they were not run for this note.

## #4153 `4b88eb717d` the site motion always runs (owner ruling 2026-11-03)

Rule: no reduced-motion query, footer switch or `?motion=on` gates the public site's motion; the wheel comes apart on scroll for everyone.

- `public/site/js/{home-up,site,product}.js` and `graphics/rf-wheel-up.{js,css}`: the switch handler, the `reduce` and `forced` queries and the `rm` watcher are gone; every page head script only adds `js-motion` and clears a leftover `rf-rm` key. The footer "Reduce motion" button is removed from nine pages, and `css/site.css` loses `.rm-toggle`, `html.rm *` and both `prefers-reduced-motion` rules.
- Phone wheel: hub logo and names fitted to their pieces.
- Tests: `app/(marketing)/site-motion-always.static.test.ts`, `site-phone-and-motion.static.test.ts`; `e2e/36-marketing-site.spec.ts` T21.

## #4158 `f65657e48c` site truth pass S3-S7 (audit 2026-11-02)

Rule: a public sentence says only what the code does for a new customer.

- `next.config.mjs`: `Strict-Transport-Security: max-age=31536000` on every route (no includeSubDomains, no preload); pinned by `app/(marketing)/hsts.static.test.ts`.
- Home, pricing, product, getting-started, security, does-and-doesnt and the wheel copy (`graphics/rf-wheel-up.js`): a pure driver on a new account is sent to the phone app's "Desktop Only" screen and the web stop sheet starts or skips a stop but cannot finish one, so the pages no longer claim the phone app, photo and signature, or finishing with no signal; staff no longer "mark an order delivered" (an order on a run is delivered when its stop is completed, SA-1098 §1); the short-delivery card is removed; "From $99 a month." on the landing.
- Test: `app/(marketing)/site-truth.static.test.ts`.

## #4159 `344ff8c04c` F13 the feature console's source chip (SA-963 W-901 slice a)

- `app/(platform-admin)/admin/tenants/[id]/_features/badge.ts`: `READOUT_CHIPS` (In plan, Add-on, Free until a date, Set for this business, Off for this business), `OVERRIDE_KIND_WORDS` / `overrideKindWords`; `FeatureConsole.tsx` `explainSentence` names the kind in words and the same UTC end date as the chip.
- Tests: `FeatureConsole.test.tsx`, `badge.test.ts`; e2e `49-feature-console.spec.ts`, `bo-web-console.spec.ts`, `bo-web-console-source-chips.spec.ts` (not run at merge time).
