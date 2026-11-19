# W3 · header lane · one trial button, a reachable menu, a steady header

Base: `rebrand/rovio-site` with every W2 lane landed (2.1b is done with `site.css`, `mobile.css`). Sources: spec-delta §3 row "P09, P10, F08, #1940" (T48), §5 W3; review-gate-5 MF6 (`site.css` has one W3 owner: this lane); ux-spec §5 Header, §10; context-pack §8 rows P09, P10, F08, D-2. Paths are under `apps/web/`.

## 1. Files
- **Owns:** `components/site-frame/SiteFrameHeader.tsx`, `components/site-frame/site-frame.css`, `public/site/css/site.css`, `public/site/css/mobile.css`, `public/site/js/site.js`; NEW `e2e/93-site-w3-header.spec.ts` (project `site-waves`). Proposed, needs SA yes (OQ-8): the "phone header" block of `public/site/css/home-up.css` (`:92-101`, where P09 lives; no other W3 lane owns the file).
- **Must not touch:** any `*.html` (the static pages' header markup belongs to the page lanes in this wave; CSS and JS only here), `SiteFrame.tsx`, `site-frame-nav.ts`, `rf-wheel-up.*`, `js/home-up.js`, `js/auth-nav.js`, the API.

## 2. Red first
| T | File · red now |
|---|---|
| T48a P09 | 93 spec: at 390x844, scrolling `/` in 0.1-window steps, never more than one visible "Start free trial" in the viewport. Red: header pill plus hero or wheel button |
| T48b P10 | 93 spec: `/signup` at 1440x900 and 393x844: no trial button in the header (`SiteFrameHeader.tsx:78-79`, `:110-111`). Red: present |
| T48c F08 | 93 spec: at 393x740 the open menu shows Sign in and the trial button without scrolling, on a static page and a React page. Red: below the fold |
| T48d | 93 spec: the header's box keeps its height and top while scrolling and opening/closing the menu (+-1 px). Red only if it moves today; otherwise a guard |
| T42 | 89 spec (2.1b): stays green after header colour changes |

**Header sign-in and focus pins that must stay green, unedited:** `components/site-frame/site-frame.test.tsx` ("phone menu links, before Sign in and the trial button"; `a.nav-signin` reads "Sign in" to `/login`, "Open dashboard" to `/dashboard`, buyer to `/buyer/portal`); `app/(marketing)/marketing-port.static.test.ts` (`:focus-visible` 3 px solid ring in site.css, R-MKT T7; no `.signin-menu` emitter); `site-auth-nav.static.test.ts`; e2e 36 T20 "Tab after landing on /#hash goes on from the section, not to the top" (`36:1327`, focus never jumps to the header or skip link).

Jest: `cd apps/web && npx jest --runTestsByPath "<path>"`. Browser: `npx next dev -p 3134` in `apps/web`, then `PLAYWRIGHT_BASE_URL=http://localhost:3134 node scripts/heavy-slot.mjs run --label w3-header -- npm --prefix apps/web run test:e2e -- --project=site-waves --project=marketing`.

## 3. Acceptance
1. One trial button per 390 viewport on `/` (D-2: the header pill steps aside while another trial button shows).
2. No header trial button on `/signup`; Sign in stays.
3. Phone menu: Sign in and the trial button visible at 393x740 on open.
4. Header steady (T48d); no new CLS (T44 runs in W5).
5. All pins above, T42, T50, T51, site-mobile-pass, site-pins and the 2.1b static tests stay green.

## 4. Exemption rows to delete
None (2.1b cleared these files).

## 5. Ledger rows closed
UX: P09, P10, F08, #1940 (GitHub issue, cited by spec-delta §3), D-2 header part. Copy: none.

## 6. Conflicts
None in W3. The wheel follow-up does not touch these files.

**Carried, not built here (B3 owner):** tenant-admin mailbox strings that still type the name, `apps/api/src/email/mailbox/mailbox-connection.service.ts:791-792` ("Microsoft doesn't let RouteFlow revoke access...", "remove RouteFlow from your Microsoft account's app permissions") and `:824` ("revoke RouteFlow's access in your Google account"). Raised by the B1b review (rec 4); not in spec-b1-email §1 or rev 4 item 3. Out of this lane's files: OQ-9.

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
Stop and report if a fix needs a file you do not own (including home-up.css before the SA yes).
Commit locally, do not push; report sha, red/green evidence, totals.
```
