# Web landing 2026-11-03, train al (merge commit `1f6f32a341`, range `d833210811..1f6f32a341`; train PR #4168, head `769749d4f8`)

Web paths under `apps/web/` unless they start with `apps/api/`. Four members: #4165 `b27c148a9c` (api only), #4162 `242e14a3a5` (docs only), #4167 `49a3f8cc83`, #4160 `b4617b1533`. No migration, no new env var. Tests are names only; they were not run for this note.

## #4167 `49a3f8cc83` more use cases on the site

Rule: every card is something a new trial customer can do today (read against code, not clicked on a trial account).

- `public/site/home.html`: `#use-cases` grows from 12 to 20 cards (`inc-more` list); `public/site/product.html`: one card in `#sell`, three in `#stores` (now plain `pd-cs`), eight in `#paid`, one in `#deliver`. The counts are gone from the words ("all of these", "all the use cases"). No CSS, JS, legal text, price or plan text.

## #4160 `b4617b1533` colour and life for the site (W-1129)

Rule: the colour is decoration, not a claim; text on every tint stays AA (4.5:1); the motion runs for everyone.

- New `public/site/css/{home-color,color-deep}.css`: kicker pills in the wheel piece's colour, tinted bands and cards, a coloured tile per use case (`--pc`/`--pi` on each `<li class="inc-i">`), press and hover feedback, tile pop on scroll, one decorative FAQ van; the seven inner pages link `color-deep.css`. `graphics/rf-wheel-up.js`: the wheel's pieces take soft colours at rest and the wash is painted into the canvas background; on phones the hub logo sits at rest.
- `scripts/sync-site-port.mjs` copies both stylesheets.
- Merge note: the train merge of #4160 over #4167 conflicted only in `home.html`'s `inc-more` list (words plus style): #4167's words, the `style` on every `<li>`, 8 of them derived from the item's own svg style. The pin in `app/(marketing)/site-color-and-life.static.test.ts` counts 22 cards (was 14).
- Tests: `site-color-and-life.static.test.ts`, `site-motion-always.static.test.ts`; `e2e/36-marketing-site.spec.ts`.

## #4162, #4165

- #4162: docs only. #4165: api only.
