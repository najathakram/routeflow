# W2c · lane FT · the site keeps the first visit's source

Ordered by the lead on 2026-11-19, from SA-1179 (the sign-up source read). Source: `local-assets/selling-system/rovio-site-brief-first-touch.md` (standalone) and `local-assets/selling-system/phase1-source-capture-spec.md`, section "Site part". The app side (the sign-up form reads the key) is on master's `feat/signup-source-capture`, held for the owner's DB sitting. This lane is the site half only.

**Order.** It starts after W2 close. It owns `js/site.js`, which the W3 header lane also owns, so the header lane starts after FT lands. The other W3 lanes do not wait for FT.

## 1. Files
- **Owns:** `apps/web/public/site/js/site.js` (one self-contained first-touch block only); NEW `apps/web/app/(marketing)/site-first-touch.static.test.ts` (jsdom; it loads the served `site.js` text and runs it); NEW `apps/web/e2e/94-site-w2-first-touch.spec.ts`. The coordinator widened `site-waves` to 88-94 for it.
- **Must not touch:** every html file, css, `rf-wheel-up.*`, `packages/types/brand/*`, `lib/*`, the app's sign-up code, `playwright.config.ts`, the pin guard and ledger (unless the lane adds a counted pin; then a ledger row in its own commit).

## 2. Behaviour
On every page view, inside `try/catch` (storage can be blocked), with no cookie, no network call and no third-party script:
1. If `sessionStorage["rf_first_touch"]` exists, do nothing. Never overwrite it.
2. Otherwise, write once if the URL has any of `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`, `msclkid`, or if `document.referrer`'s host differs from `location.host`. The record is an object of only the keys that have a value: the eight above, `landingPath` (`location.pathname` only, no query), `referrerHost` (hostname only; left out when it is this site) and `firstSeenAt` (`new Date().toISOString()`).
3. The key name `rf_first_touch` is a storage identifier: it stays as is through the rename (E29).

## 3. Red first
| T | Case (jsdom unless marked) |
|---|---|
| FT1 | `/pricing?utm_source=test&utm_medium=email` with an empty referrer: the record is exactly `{utm_source:"test", utm_medium:"email", landingPath:"/pricing", firstSeenAt:<ISO>}` |
| FT2 | an existing key is never overwritten by a second view with other tags |
| FT3 | a cross-site referrer with no tags: `referrerHost` is the hostname only (not the path or query), plus `landingPath` |
| FT4 | a same-site referrer with no tags: nothing is written |
| FT5 | no tags and no referrer: nothing is written |
| FT6 | the query does not leak into `landingPath`; empty values (`utm_term=`) are left out |
| FT7 | `sessionStorage.setItem` throws: the page script still runs, and no error escapes |
| FT8 | static: the block holds no `document.cookie`, `fetch(`, `XMLHttpRequest` or `sendBeacon` |
| FT9 (94 spec, `site-waves`) | the done-when walk on next dev: `/pricing?utm_source=test&utm_medium=email`, click to `/`, then "Start free trial". `sessionStorage.rf_first_touch` keeps `utm_source:"test"` and `landingPath:"/pricing"`, unchanged after more views |

Each case must fail on the wrong value (a missing guard, a full referrer URL, an overwrite).

## 4. Acceptance
1. FT1-FT9 green; red evidence saved for each.
2. `site-page-read-pin`, `site-pins`, `site-speed-budget` (site.js size), `no-control-bytes` and every `site-*` static test green by path.
3. No brand word in comments or commit messages.

## 5. Builder prompt (model sonnet, effort medium)
```
You are lane FT of the site rebrand: the site keeps the first visit's source. Work only in the worktree
and local branch the coordinator gives you. Read .claude/pipeline/2026-11-11-rovio-rebrand/briefs/W2c-first-touch.md
and briefs/README.md, then apps/web/public/site/js/site.js. Edit only the files the brief says you own.
For each row in §3: red first, save the output, then fix. Jest by path only; the 94 spec on your own next dev
port through scripts/heavy-slot.mjs. Tests read pages only through readServedSitePage; never add to the
page-read allow-list. No snapshot tests. Never git stash, switch, reset --hard or checkout a ref; never npm
install; never push. Stage by explicit path. Control-byte scan before each commit. Conventional Commits,
trailer "Bookkeeping-Follow-Up: pending". Stop and report if an expected red is green or a fix needs a file
you do not own. Commit locally; report shas, red/green evidence, totals.
```
