# Discovery — marketing interface port + logo update (Phase 1 of the redesign migration)

Status: PLANNED · Fable @ high, 2026-09-07 03:3xZ · worktree `rf-watchdog`, branch `feat/marketing-port` off master 5ddec78e ·
scale **major**, `ui: true` · owner instruction 2026-09-07 03:1xZ: "just do the marketing interface part for now, also update the logo".

## The problem, in the requester's words

The owner has redesigned RouteFlow's website and interfaces in a separate Codex project
(`C:/Users/nakram/Documents/Codex/2026-09-06/rev/work/routeflow-redesign`, READ-ONLY for every session). The intake audit
(`local-assets/handoff/2026-09-06/redesign/MIGRATION-PLAN.md`) ruled that only the **marketing half** is portable now:
the public pages are unauthenticated, carry no tenant theming, plan gates, i18n keys, uploads, print views or E2E projects,
and they are the one surface where the redesign is more complete than the live site. The owner wants that half live,
together with the **new logo**, before anything else.

- **Whose problem:** the owner (sales/marketing: the public site is the first thing a prospect sees) and prospects
  (distributors and retailers evaluating RouteFlow). Frequency: every visit to `www.routeflow.info`.
- **Cost today:** the live marketing pages (`apps/web/app/(marketing)/*`, 7 routes) carry the old identity; the
  redesign exists only as a private preview on a `*.chatgpt.site` origin with indexing off. Two designs of the same
  product are visible to anyone who has both links.
- **Workaround and why it fails:** none — the preview cannot be pointed at the real domain (different runtime, no
  auth, no tenant hosting) and cannot be linked from the app.
- **Why now:** the redesign is finished enough for the public pages; the owner asked for it explicitly; every day of
  delay is a day the public site contradicts the owner's current brand.
- **If we ship nothing:** the app keeps working; the brand stays split; the redesign's marketing work decays as the
  live site evolves. Cost is commercial, not operational.
- **Success signal (one, observable):** `www.routeflow.info` and its 8 public pages render the redesign's sections
  and copy with the new logo, indexable, on the live stack, with every existing marketing Playwright assertion green
  or replaced in the same PR, and the new logo visible on every web surface that showed the old one. Baseline today:
  0 of 9 pages (home + 8) on the new design; old logo everywhere.
- **Who else is affected:** logged-in users see the new logo in the dashboard chrome, auth pages and buyer portal
  (a visual change only — no flow changes); email recipients if API templates embed a web-hosted logo URL.
- **Symptom or problem:** the problem. The request is not a symptom of something else.
- **Solving or building someone's pick:** building the owner's pick (the redesign), deliberately scoped to the
  half the evidence supports.

## The strongest objection, answered

"Porting into Tailwind 3 / Radix / React 18 is a re-authoring, not a port — why not upgrade the foundation?"
Because the foundation upgrade (five majors) would land on every live tenant before any visible benefit, while four
fix branches and two bug engines still sit on `apps/web`; the audit's refuter rejected that ordering. The marketing
pages are ~10 static screens with two client demos; re-authoring them on the live stack is bounded work, and the
redesign's own components are mostly plain markup once the Tailwind-4-only syntax is translated.

## Sources reused

Code map `web.md` (marketing routes, layout, components); `design-system.md` (Ledger tokens, `.surface-*` pattern,
primitives, motion, a11y baseline); intake audit `intake.json`; inventories
`local-assets/handoff/2026-09-06/redesign/marketing-inventory-redesign.md`, `marketing-inventory-live.md`,
`marketing-portability.md` (read-only readers, 2026-09-07); lessons `L-072` (no hand-mirrored shapes), `L-076`
(scope locators), `L-086` (post-deploy oracles from the API; `#main-content` scoping).

## Decisions carried in (lead rulings)

- Marketing pages only + the logo everywhere the web app renders it. The workspace half of the redesign stays a spec.
- Light mode only (the live app has none); the redesign's dark tokens are not ported.
- Marketing identity attaches as a **scoped surface** (`.surface-marketing`: fonts, palette, radius) so the app's
  Ledger tokens and every tenant `--primary` override are untouched. The logo is the one global change.
- Privacy and terms: page shells in the new design with honest interim copy ("being finalised — contact us"),
  `noindex`, linked from the footer as the design has them. No placeholder legal text.
- SEO stance fixed to the real origin (`www.routeflow.info`): `robots index,follow`, `metadataBase`, sitemap for the
  public routes. Nothing from the preview origin ships.
- Mobile app icons (`apps/mobile/assets/`) are build assets: owner/EAS, out of scope. Logo in API emails: in scope
  only where a template embeds a web-hosted asset URL or inline SVG.
- Dead redesign dependencies (three.js scene, recharts wrapper, `brand-colors.css`) are NOT ported.
