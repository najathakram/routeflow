# SA-1174 A1 · site rebrand: owner answers recorded + three builder choices on the briefs at cfa5cb26b6 · ruling

- SA-1174 A1 · 2026-11-19T20:25Z · from the lead. Lens tier: the SA answered the five seat questions in one pass.
- Facts were read on the rebrand branch at cfa5cb26b6, and on origin/master at 6317cc870c for the wheel script that step 0 brings in. Brand-free, as SA-1174.
- **(a) CONFIRMED, with 3 conditions.**
- **(b) AMENDED:** the static still uses `symbolOnDark` too.
- **(c) CONFIRMED if it means "no Path2D path data"; AMENDED if it means "no `symbolOnDark` value".** In that case the fixture needs its own distinct path.
- **Owner answers:** recorded under K15-K18. Item 1 is open again, as a second box drafted by the rebrand seat.
- **K13:** the fix-shape ruling is queued after the rebrand items.
- checked: a, b, c, owner 1-4.

## Facts (quoted)
| # | Fact | Where |
|---|---|---|
| F1 | The static still's hub is a dark disc: `<circle r="116" fill="#10264d"/>`. The typed mark `<g class="mk">` sits on it. | rebrand branch at cfa5cb26b6, `apps/web/public/site/home.html:114` |
| F2 | The live hub strokes the typed mark in white on the same dark disc: `ctx.strokeStyle = "#fff"; ctx.stroke(MARKP)`. | origin/master 6317cc870c, `apps/web/public/site/graphics/rf-wheel-up.js:331,475,481` |
| F3 | The wheel sub line in the script: `{ t: "One system.", s: "Every step is in <current name>." }`. The page copy carries the same sentence. | rf-wheel-up.js:45-48 at 6317cc870c |
| F4 | `BRAND_KEYS` lists every key the reader checks. `validateBrand` throws on the first missing or empty key. | rebrand branch, `packages/types/brand/load.ts` (BRAND_KEYS, validateBrand) |
| F5 | The T45 fixture gives every path its own `/fx/...` value (`symbol: "/fx/symbol.svg"`). spec-delta:44 says T45 expects "every name, src and colour from the fixture". | `app/(marketing)/site-brand-fixture.test.ts:42`; spec-delta:44 |
| F6 | The briefs' suggested landing order: S2, 2.2, 2.1b, 2.1b-last. | briefs README "Order and parallel groups" |
| F7 | The lead verified at origin/master 4bab5f4410: deactivation runs only when the tenant is over the new plan's cap (`billing-cron.service.ts:543-563`). The warning text is at `subscription-mutation.service.ts:1290`. | lead, 20:22Z |

## Rulings
- **K14a · (a) the sub-line static test belongs to lane 2.2: CONFIRMED.** 2.2 owns the script, and the test only reads `home.html`. Conditions:
  1. The test never types the sentence or the name. It takes the sub line from each file, swaps the name placeholder on each side for one marker (`{{brand:name}}` in the html; the name variable read from `og:site_name` in the script), and compares the rest byte for byte. Each side must hold exactly one marker.
  2. **2.2 lands after S2** (F6 becomes binding for this pair). Otherwise the test reads S2's un-tokenised page and goes red.
  3. Red proof: change one character on one side only, and it must fail.
  - The wording itself waits for the owner's second box (K15). The test can land before the wording because it compares; it does not pin the sentence.
- **K14b · (b) the static still uses the reversed symbol too. AMENDED.**
  - Both marks sit on the same dark disc (F1, F2). The static still is what a visitor sees before the script runs, and when it never runs. With `symbol` it would show the light-surface mark on dark, and the colour would jump when the live hub takes over.
  - So S2 replaces `<g class="mk">` with `<image href="{{brand:symbolOnDark}}" .../>`.
  - `{{brand:symbol}}` stays for light surfaces only.
  - The disc's hex (`#10264d`) stays 2.3-home's W3 job, under the hex row from SA-1174 K5.
- **K14c · (c) the T45 fixture.**
  - If "no path" means no Path2D or path-data key: CONFIRMED, as SA-1174 K1 rules it out.
  - If it means `symbolOnDark` has no fixture value: AMENDED.
    - Add `symbolOnDark` to `BRAND_KEYS` (the reader checks every key, F4).
    - The fixture gets its own value, e.g. `symbolOnDark: "/fx/symbol-dark.svg"`, distinct from `symbol`.
    - Once home is tokenised (S2's T45 flip to 10 pages), T45 asserts that both the home template `src` and the static still's `href` equal the fixture's `symbolOnDark`, and that neither equals `symbol`.
    - Without a distinct value, T45 cannot tell a crossed-over key from a correct one (F5).
- **K15 · owner item 1, the home lines: not accepted.** The owner asked for the lines to sound more natural. The rebrand seat drafts 2-3 sets for a second box, sent by the lead. Every set must:
  1. never end a sentence with the name (T37: the name followed by `.`, `!` or `?` fails);
  2. give ONE wheel sub-line string, used in both files (K14a);
  3. use a FAQ question that either matches the Pricing FAQ's wording or changes both pages together.
  - Nothing that holds these lines is built before the answer. The T37 home rows stay red and reported (W2-S2 brief).
- **K16 · owner item 2: delete it.** S2 deletes the "Smaller plan." item at `product.html:303` in its own commit. That line of the S2 brief is now unblocked.
  - The precise fact (F7): when a team is over the smaller plan's limit, every staff and driver login is turned off, not only the extra ones. A true line may come back after K13's fix.
- **K17 · owner item 3: switch on the same day.** On switch day, B3's mailbox strings and pins switch together with the app names in the two provider consoles (the D0 list). Until then the strings keep the old name.
- **K18 · owner item 4: "Skip to plans".** It is built only if T46b is red at the 2.3-pricing base (SA-1174 K12).
- **K13 queue:** the fix-shape ruling (a "who keeps access" chooser vs. a true warning) is next after this, before bug-pipeline. It runs at Quick tier or higher because it is billing.

## Seat answers (Lens)
- **Architect:**
  - one comparison test, placed in the lane that owns the script;
  - one dark-surface key used by both dark marks;
  - the fixture keeps one distinct value per key;
  - diff: XS each.
- **Bug skeptic:**
  - (b) as built ships the wrong-colour mark to every visitor before the script runs, and nothing catches it unless T45 tells the keys apart (K14c);
  - (a) goes red if 2.2 lands first.
- **User advocate:** a visitor sees one mark in one colour from the first frame to the live wheel. The sub line reads the same in both places.
- **Business seat:** nothing sells or gates here. It is a brand-quality fix only, and no site claim changes.
- **Red team:** "The static still is rarely seen." No: it is the first paint for every visitor and the whole wheel for anyone whose script fails. That holds up (b).

## Case table
| Check | Expected | Status |
|---|---|---|
| sub-line test, one side changed by one character | red | observe and report (K14a) |
| sub-line test with 2.2 landed after S2 | green | observe and report |
| T45 with `symbolOnDark` and `symbol` swapped in the template | red | observe and report (K14c) |
| home at 393 and 1440 before the script runs | reversed mark on the disc | observe and report (K14b) |
| `validateBrand` on a brand missing `symbolOnDark` | throws naming the key | observe and report |

## Pins kept or superseded
- **KEPT:** SA-1174 K1-K12; the swap rule ("2 JSON lines + 13 assets": `symbolOnDark` is a neutral file name the kit copy overwrites).
- **AMENDED:**
  - SA-1174 K1: the static still also uses `symbolOnDark`;
  - the W2-S2 brief's static-still line (`{{brand:symbol}}` → `{{brand:symbolOnDark}}`);
  - the W2-S2 brief's `product.html` line (unblocked: delete `:303`).
- **SUPERSEDED:** SA-1174 owner-box item 1's recommended lines (the owner did not accept them).

## Design Gate (Lite) — SA-1174 A1 site rebrand builder choices · 2026-11-19 · base cfa5cb26b6
- G1 Fit: the site rebrand program, wave 2. Extends `packages/types/brand/load.ts:47` (BRAND_KEYS) and `apps/web/public/site/home.html:114` (the static still); the script read at origin/master 6317cc870c, `rf-wheel-up.js:475`.
- **Area sweep:** the three builder choices, plus the owner's four answers.
  - Added: the reader check for the new key, and the S2-before-2.2 landing order.
  - Deferred: K13's fix shape (next in queue).
- **G2 Variation:**
  - Visitors on phone and desktop: BUILD NOW.
  - Visitors whose script never runs: BUILD NOW (K14b).
  - Tenant business types: N/A (no in-app change).
  - SEAM NOW: `symbolOnDark` for every dark mark.
- **G3 Replace-later:** nothing built here is replaced. The name swap overwrites files, not code.
- **G4 Class:** one dark-surface key for every dark mark; one comparison test for the twin string. Red: K14a's one-side edit, and K14c's swapped keys.
- **G5 Data & time:** no schema. The reader rejects a brand without the key.
- **G6 Scale:** no runtime cost.
- **G7 UX:** one mark colour from first paint; the same sub line everywhere.
- G8 Change: carried by the brand keys. Future: the name swap → XS (unchanged). Future: a new dark surface → XS.
- **G9 Cost:** brief edits plus one fixture line. No lane grows.
- G10 Owner questions: none new. Item 1 returns as the rebrand seat's second box, through the lead.
