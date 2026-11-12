GATE: PASS
VERDICT: APPROVE

Base: origin/master. Round 4, narrow re-check of the round-3 items only.

| Id | Status | Line |
|---|---|---|
| N4 | FIXED | build-plan WP1.2 step 3: phone `F.flat` box `b: legend.offsetTop - 12 - hint.offsetHeight - 6`; separate phone `F.end` from `bottomOf(hx[1], hx[1].lastElementChild) + 18` to `H - 18` |
| N1 | FIXED | same block plus test-plan T3 (`rest`: hint box off the legend; `one`: wheel off `hx[1]` and its button) |
| M6 | FIXED | carried by N4 (a was the only open part) |
| N5 | FIXED | WP2.6 Do: `git mv apps/web/app/favicon.ico apps/web/public/favicon.ico`, listed in root `metadata.icons.icon`; root layout's only change |
| N3 | FIXED | WP2.6 Do (full metadata list) + N5 + S-h below |
| S8 | FIXED | WP1.2 step 3 "Too small to read": NEW `tiny` media key, `mm.add({ tiny }, () => { still(); })`, every live key excludes it |
| S-f | FIXED | test-plan T34 "And `returnUrlsOffBase` with the allow-list…" (look-alike expired, `u === o \|\| startsWith(o + "/")`, parsed like `webBaseUrl()`) |
| S-g | FIXED | build-plan WP3.1 step 7 restores both `WEB_URL=https://www.routeflow.info` and `WEB_ORIGINS=https://www.xrovio.com` |
| S-h | FIXED | WP2.6 Do: `appleWebApp` restated whole (`title`, `capable`, `statusBarStyle`, `startupImage`); `viewport.themeColor` white |
| G4 Cl.4 | FIXED | spec.md:221 adds file-based metadata (`favicon.ico`, `icon.*`, `apple-icon.*`, `opengraph-image.*`) |
| G10 | FIXED | spec.md G10: "D4-D7 were ruled in two more boxes the same day (§4)" |

## Facts verified (origin/master)

- `hint` (`$(".rfw-hint")`), `hx` (`$$(".rfw-h")`) at JS:282; `bottomOf(h, e)` at JS:576; `hintAt` at JS:588 (6 px under the wheel on phone); today's phone `F.end` box at JS:596. `hx[1].lastElementChild` is the moved `.sy-go` once the End-state bullet lands; before that it is `.rfw-sub`, so the expression is right either way.
- Favicon: middleware matcher (middleware.ts:121) excludes the path `favicon.ico`, not the folder, so `/favicon.ico` from `public/` is served the same. `marketing-port.static.test.ts` retires only `public/favicon.svg` / `.png` and bans the strings `favicon.png`, `favicon.svg`, so neither `public/favicon.ico` nor a `"/favicon.ico"` icons entry turns a test red. No other repo reference to `app/favicon.ico`.
- `tiny`: sound. A conditions-object branch runs when any key matches, so "excludes" means each of `wide`/`land`/`narrow`/`low` gets the complement as `min-` bounds (expressible: tiny = `(max-width:A), (max-height:B)`, complement = `(min-width:A+) and (min-height:B+)`). GSAP reverts before matching, as with print. Give `tiny` the same `screen and` prefix as step 6.

## Must-fix

None.

## Note for the builder (not a gate item)

- `hint.offsetHeight` reads 0 if an earlier `layout()` ran `hintAt(false)` (`display: none`). Measure it before `hintAt` hides it, or cache the height, so a resize from a short phone to a tall one does not fit `F.flat` with no hint room. T3 mounts fresh, so it will not catch this.
- Step 3's phone block takes the place of the existing JS:594 and JS:596 assignments. Delete those, do not leave them after the new block.
