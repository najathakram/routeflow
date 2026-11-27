# W3 · header lane · one trial button, a reachable menu, a steady header

Base: `rebrand/rovio-site` with every W2 lane landed (2.1b is done with `site.css`, `mobile.css`). Sources: spec-delta §3 row "P09, P10, F08, #1940" (T48), §5 W3; review-gate-5 MF6 (`site.css` has one W3 owner: this lane); ux-spec §5 Header, §10; context-pack §8 rows P09, P10, F08, D-2. Paths are under `apps/web/`.

## 1. Files
- **Owns:** `components/site-frame/SiteFrameHeader.tsx`, `components/site-frame/site-frame.css`, `public/site/css/site.css`, `public/site/css/mobile.css`, `public/site/js/site.js`; NEW `e2e/93-site-w3-header.spec.ts` (project `site-waves`). All of `public/site/css/home-up.css` (the P09 rules are at `:92-99`) and `public/site/js/home-up.js:64` (the hero-only `hero-btn-in` toggle, that line only), granted by SA-1174 K6 and K7. Build one observer in `js/site.js`: "the header trial pill is hidden while any other trial button is in the viewport". Delete the hero-only toggle at `home-up.js:64`, so only one script toggles the class; `SiteFrameHeader.tsx:53`, which hard-codes the class, follows.
- **Must not touch:** any `*.html` (the static pages' header markup belongs to the page lanes in this wave; CSS and JS only here), `SiteFrame.tsx`, `site-frame-nav.ts`, `rf-wheel-up.*`, `js/home-up.js` (except the `:64` toggle), `js/auth-nav.js`, the API.
- **SA-1180 (3):** the three `%23` hex literals in the `mobile.css` hero ring data-URI become the hex of current palette values (a data-URI cannot read a variable). Widen T35d red first: decode `%23` hex inside `url()` and fail unless the colour is in the palette value set. In the same commit, `site-mobile-pass` drops its pins on the old literals.
- **P01, the css half (moved from 2.3-pricing by the lead, 2026-11-20; one owner per file).**
  - The problem: the plan cards' bottoms do not line up. At 1440 the Starter card is 221 px taller than the others, because the grid uses `.pgrid{align-items:start}` (`site.css:102`).
  - The fix: make the cards in a row equal height with no empty band above the button. Use `align-items:stretch` (the card is already a flex column with `.pcard` at `site.css:103` with `.pbtn{margin-top:auto}` at `:188`) or subgrid rows.
  - Red first: e2e 89 T46a (the gap between a card's last content block and its button is at most 32 px, at 1440x900 and 393x844), plus a new 93 case: every `.pcard` in one `.pgrid` row has the same bottom (+-1 px) on `/pricing` and home `#pricing`. Red today on the shortest card.
  - The pricing markup was done in 2.3-pricing; edit no html.
  - The 2.3-pricing review (2026-11-20) found that stretching alone may leave an empty band above the Starter button. Give the css half its best fix and run T46a. If T46a stays red only because of markup (for example the button sits after a long list), stop and report; the markup half goes back to a pricing follow-up. Grant: this lane may edit e2e 89's T46a case only, so that it measures the gap from the card's last text line, not its last block box.
- **`.band-line` (from the 2.3-pricing review, 2026-11-20).** 2.3-pricing put the class `band-line` on pricing's top band (`band-white band-line`) in place of an inline border. This lane adds the rule `.band-line{border-bottom:1px solid var(--rf-line)}` to `site.css`, next to the band classes at `:79-81`. Red first, in a 93 case: on `/pricing` at 1440x900 and 393x844, the top band's `borderBottomWidth` is 1px and `borderBottomColor` equals the page's `--rf-line` token (read at test time). Red today: no line.
- **SA-1186 K5, the empty heading dot (`local-assets/lead-2026-11-14/sa/SA-1186-2-3-home-review-backlog.md`).**
  - The problem: `.uc-t h3::before{…background:var(--pc)}` at `home-up.css:43`. No page sets `--pc` any more, so each of home's 4 use-case headings draws an empty 10px dot and its gap.
  - The fix: delete `.uc-t h3::before`, plus any `gap` or `display:flex` on `.uc-t h3` that exists only for the dot. Observe and report what you removed.
  - The class guard, in the same commit, red first: a static check that every `var(--x)` read in `home.css`, `home-up.css` and `home-color.css` names a property declared on the site (or set inline in `home.html`), unless it has a fallback. Red today: `--pc`.
  - Order: this lands before or with 2.3-home's merge into the rebrand branch. If this lane cannot, 2.3-home takes a one-line grant for it instead.

## 2. Red first
| T | File · red now |
|---|---|
| T48a P09 | 93 spec (D-2): at 390x844, scrolling `/` in 0.1-window steps, while any trial button other than the header pill is in the viewport, the header pill is not visible. No total count: stacked plan cards are not the header's. Show it red at the lane base before the fix (header pill plus hero or wheel button) |
| T48b P10 (as written) | 93 spec: `/signup` at 1440x900 and 393x844: no trial button in the header (`SiteFrameHeader.tsx:78-79`, `:110-111`). Red: present |
| T48c F08 (as written) | 93 spec: at 393x740 the open menu shows Sign in and the trial button without scrolling, on a static page and a React page. Red: below the fold |
| T48d | 93 spec: the header's box keeps its height and top while scrolling and opening/closing the menu (+-1 px). Kept as a guard, with a self-check: an `addStyleTag` that makes the header `position:static` must turn it red (SA-1174 K12) |
| T42 | 89 spec (2.1b): stays green after header colour changes |

**Header sign-in and focus pins that must stay green, unedited:** `components/site-frame/site-frame.test.tsx` ("phone menu links, before Sign in and the trial button"; `a.nav-signin` reads "Sign in" to `/login`, "Open dashboard" to `/dashboard`, buyer to `/buyer/portal`); `app/(marketing)/marketing-port.static.test.ts` (`:focus-visible` 3 px solid ring in site.css, R-MKT T7; no `.signin-menu` emitter); `site-auth-nav.static.test.ts`; e2e `36:T20` "Tab after landing on /#hash goes on from the section, not to the top" (`36:1327`, focus never jumps to the header or skip link). Exact paths (SA-1174 K11): `components/site-frame/site-frame.test.tsx:29,68-81`; `app/(marketing)/marketing-port.static.test.ts:318-320,331`; `app/(marketing)/site-auth-nav.static.test.ts` (whole file); e2e `36:1327` (`36:T20`). "Unedited" means `git diff --stat <lane base>..HEAD -- <those paths>` prints nothing.

Jest: `cd apps/web && npx jest --runTestsByPath "<path>"`. Browser: `npx next dev -p 3134` in `apps/web`, then `PLAYWRIGHT_BASE_URL=http://localhost:3134 node scripts/heavy-slot.mjs run --label w3-header -- npm --prefix apps/web run test:e2e -- --project=site-waves --project=marketing`.

## 3. Acceptance
1. While any trial button other than the header pill is in the 390 viewport on `/`, the header pill is hidden (D-2; T48a), done by the one observer in `js/site.js`; the hero-only toggle at `home-up.js:64` is gone.
2. No header trial button on `/signup`; Sign in stays.
3. Phone menu: Sign in and the trial button visible at 393x740 on open.
4. Header steady (T48d); no new CLS (T44 runs in W5).
5. All pins above, T42, T50, T51, site-mobile-pass, site-pins and the 2.1b static tests stay green.

## 4. Exemption rows to delete
None (2.1b cleared these files).

## 5. Ledger rows closed
UX: P09, P10, F08, #1940 (GitHub issue, cited by spec-delta §3), D-2 header part. Copy: none.

## 6. Conflicts
None in W3. The wheel follow-up does not touch these files. Pin ledger (SA-1174 K4): this lane writes its own ledger change in its own commit and never lands while site-pins is red; a lane that adds a counted pin raises the baseline in its own commit, listing the pins; delete no pin (stop and report); never edit master's guard; the report lists each edited pin literal, old -> new.

**Carried, not built here (B3 owner):** tenant-admin mailbox strings that still type the name, `apps/api/src/email/mailbox/mailbox-connection.service.ts:791-792` ("Microsoft doesn't let RouteFlow revoke access...", "remove RouteFlow from your Microsoft account's app permissions") and `:824` ("revoke RouteFlow's access in your Google account"). Raised by the B1b review (rec 4); not in spec-b1-email §1 or rev 4 item 3. Out of this lane's files: OQ-9, ruled SA-1174: B3 owns the three mailbox strings, built from `BRAND.name`, together with their pins (`mailbox-connection.service.spec.ts:578`, `MailboxCard.test.tsx:61,65,481`, `e2e/mailbox-connect.spec.ts:89,92`, and the `MailboxCard.tsx:178` comment), in one change. When it switches is decided (item 3, owner box 2026-11-19 ~20:22Z: "On switch day"): B3 renames the app in both the Google and Microsoft consoles on switch day and the three sentences switch the same day; until then the old name stays in them. Not built in this lane.

## 7. Caps
Format only changed lines. Before every commit `grep -lP "[\x00-\x08\x0B\x0C\x0E-\x1F]" <changed files>` prints nothing; the control-byte pin on the merged branch also flags 0x0B, 0x0C and 0x0E-0x1F.

## 8. Builder prompt (model sonnet, effort medium)
```
You are the header lane of the site rebrand: one trial button per phone viewport, none in the header on
/signup, Sign in and the trial button reachable in the open phone menu, and a header that does not move.
Work only in the worktree and local branch the coordinator gives you. Read:
.claude/pipeline/2026-11-11-rovio-rebrand/briefs/W3-header.md, ux-spec.md §5 and §10, CLAUDE.md.
Edit only the files the brief says you own; never a page's html.
For each row in brief §2: red first in e2e/93-site-w3-header.spec.ts, save the output, then fix. The
listed sign-in and focus pins stay green and unedited. Jest by path only; browser tests on your own next
dev port through scripts/heavy-slot.mjs.
Rules: Jest + Playwright, no snapshot tests, a sweep that finds nothing throws, no sleeps, select by
structure or data-testid, never by a responsive utility class. Format only the lines you change. No brand
word in code, comments or commit messages. Never git stash, switch, reset --hard or checkout a ref; never
npm install; never push. Stage by explicit path. Control-byte scan before each commit (0x00-0x08, 0x0B,
0x0C, 0x0E-0x1F). Conventional Commits, e.g. "feat(site): one trial button and a reachable phone menu
(header lane)", trailer "Bookkeeping-Follow-Up: pending".
T48a: while any trial button other than the header pill is in the viewport, the header pill is not visible; show it
red at base first. T48d keeps a self-check: an addStyleTag making the header position:static turns it red. One
observer in js/site.js replaces the hero-only toggle at home-up.js:64 (that line only); SiteFrameHeader.tsx:53
follows. You own all of home-up.css. Leave the sign-in and focus pins unedited (git diff --stat prints nothing for
those paths). Write your own pin-ledger change in your own commit; never land while site-pins is red; delete no
pin; list each edited pin literal old -> new.
Stop and report if a fix needs a file you do not own.
Commit locally, do not push; report sha, red/green evidence, totals.
```
