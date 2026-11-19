# UX spec: the Rovio website (Program A)

> Run `2026-11-11-rovio-rebrand` · Status `DRAFT` · `R#` in [spec.md](./spec.md), `E#` in [discovery.md](./discovery.md) §0.
> Sources of the look: the website guide (E23) and brand kit v2 (E22). Reference pictures:
> `local-assets/proofs/2026-11-11-rovio-rebrand/guide/*.png` (target) and `live-now/` (today).
> Paths below are relative to `apps/web/public/site/` unless they start with `apps/`.

## 1. Job to be done

A wholesaler who has never heard of the product must understand, within the first scroll, what it does
and what each part is, on whatever screen is in their hand, and meet one calm brand the whole way to
the sign-in form.

## 2. Derived system (what exists today; extend it, do not invent)

| Thing | Where it lives today | Rule for this work |
|---|---|---|
| Colour, type scale, corners, shadows | `graphics/rf-graphics.css:5-25` (the `tokens:start/end` block), aliases in `css/site.css:6-7` | values and names change per §3; type scale and corners do not |
| Wheel and section tints | `css/home-color.css:6-8`, `css/color-deep.css:5-7`, hex data in `graphics/rf-wheel-up.js:17-38` | retired; wheel colours move into the token block |
| Art roles (box, road, disc, cargo) | `graphics/rf-graphics.css:27-34` | keep the role names, change values |
| App-picture colours | `graphics/rf-graphics.css:37-44` (`--app-*`, `--buy-*`) | keep the names, change values (D7) |
| Font | `fonts/Geist-Variable.woff2`, `--rf-font` | unchanged (D6) |
| Breakpoints | 900 px width; 600 px and 500 px height; `land` = narrow, low and landscape (`rf-wheel-up.js:229-230`, `js/home-up.js` `mob`) | unchanged; every condition gains `screen and` (§7) |
| Motion | GSAP 3.15 + ScrollTrigger, scrub .7, snap to beats, press `scale(.965)`, card hover lift 4 px | unchanged except where §4 says |
| Static (no-script) layout | `html:not(.js-motion)` rules; `.rfw--static` still | unchanged; print reuses it |
| Legends | `.rfw-keys` (in the still), `.rfw-list` (screen readers), `.sy-parts` (below the wheel) | reuse `.rfw-keys` on the live stage; add no fourth list |

## 3. The token contract (lands first; WP2.0)

This block replaces lines 6-22 of `graphics/rf-graphics.css`. The type-scale, corner and font lines
inside the block stay exactly as they are today and are not repeated here.

```css
:root{
  /* Rovio palette. Source of truth: packages/ui/src/tokens/rovio-palette.json (brand kit v2), pinned by T14a. */
  --rf-ink:#0E1726;--rf-ink-press:#04070D;--rf-steel:#5A6675;--rf-white:#FFFFFF;--rf-bone:#F6F4F0;--rf-line:#E4E1DB;
  --rf-copper:#B5683A;--rf-copper-light:#D69062;--rf-copper-dark:#8F4E27;
  /* Jobs. A rule names a job, never a palette colour. */
  --rf-text:var(--rf-ink);--rf-text-2:var(--rf-steel);
  --rf-btn:var(--rf-ink);--rf-btn-press:var(--rf-ink-press);--rf-btn-fg:var(--rf-white);
  --rf-panel:var(--rf-ink);--rf-on-panel:var(--rf-white);--rf-on-panel-2:var(--rf-bone);
  --rf-soft:var(--rf-bone);
  --rf-link:var(--rf-copper-dark);--rf-link-on-panel:var(--rf-copper-light);--rf-focus:var(--rf-copper-dark);
  --rf-accent:var(--rf-copper);--rf-accent-on-panel:var(--rf-copper-light);
  /* Status: Paid, Pending, Overdue and nothing else. */
  --rf-paid-bg:#DDF3E6;--rf-paid:#12714A;--rf-pending-bg:#FFEFC7;--rf-pending:#8A5A00;--rf-overdue-bg:#FBE0DC;--rf-overdue:#A1261D;
  /* Wheel roles. The canvas reads these once at mount with getComputedStyle. */
  --rf-wh-work:#E9E4DB;--rf-wh-work-2:#DCD6CB;--rf-wh-work-wall:#C2BBAE;
  --rf-wh-sell:#1B2638;--rf-wh-sell-2:#27364C;--rf-wh-sell-wall:#04070D;
  --rf-wh-focus:#B5683A;--rf-wh-focus-wall:#8F4E27;
  /* The only edge treatment: a one-pixel line. */
  --rf-ring:0 0 0 1px var(--rf-line);
}
```

Retired names (zero references may remain, R14): `--rf-brand-900/700/500/300/100`, `--rf-on-navy`,
`--rf-link-on-navy`, `--rf-tint`, `--rf-ink-2`, `--rf-ink-3`, `--rf-sun(-soft)`, `--rf-coral(-soft)`,
`--rf-mint(-soft)`, `--rf-ok`, `--rf-sh-card/sample/win`, `--pc-*`, `--fld-*`, `--k-bg/--k-ink/--k-dot`
tint pairs, and the `--navy`, `--navy-d`, `--sun`, `--tint` aliases. Each use is re-pointed by hand to a
job: this is the audit that stops copper leaking into fills that used to be mid-blue (E17).
Art roles: `--rf-box-top:#EACBB3; --rf-box-front:#D69062; --rf-box-side:#B5683A` (E23).
App pictures (D7): rail and primary `--rf-ink`, canvas `--rf-bone`, lines `--rf-line`, text `--rf-ink` /
`--rf-steel`, status from the status tokens. No teal, no emerald.

## 4. The six rules, as checks

| Rule | Check |
|---|---|
| Three backgrounds | every band is `#FFFFFF`, `#F6F4F0` or `#0E1726` (R15) |
| One copper thing per screen | copper only in its listed jobs (R17); reviewers count per screenshot |
| Buttons are ink | `--rf-btn`; white on ink panels; links per `--rf-link*` (R16) |
| Flat | no gradient, blur, glow, shadow; `--rf-ring` only (R18) |
| Icons on tiles, words beside them | no text is drawn on the canvas (R6) |
| Status colours stay | status tokens appear only on Paid, Pending, Overdue marks |

## 5. Screen inventory and treatments

Pages: `/` (home), `/pricing`, `/product`, `/company`, `/contact`, `/getting-started`,
`/does-and-doesnt`, `/data-in-and-out`, `/security`, `/landing` (static); `/privacy`, `/terms`,
not-found, sign-in, sign-up, password reset, store sign-in (React, inside the site frame, R26).

### Home, section by section

| Section (live heading) | Today (E9-E11, proof sheets) | Rovio |
|---|---|---|
| Header | white, navy button, mark + typed name | white on a one-pixel line; ink button; logo file (§8) |
| First screen | blue chip; navy button | bone chip with a copper dot; ink button; "See what you can do" and "Scroll to look inside" in copper dark; Payments tile copper |
| Wheel | ten colours, names on tiles | §6 |
| What each part does | list under the wheel | same list; group labels gain an ink and a bone square |
| "Orders in texts. Prices in your head. Bills on paper." | navy; yellow, green and blue notes | ink; notes in bone and white, one in copper light; the closing line in copper light |
| "The order becomes the invoice." | cream band | bone band; a copper underline under the step in view; white cards on a line; ink number badge |
| App window picture | teal buttons | white band; picture in the Rovio app colours |
| Box or piece · Each store's price · Stores order online · Counter | lavender, lavender, mint, lavender bands | white, bone, white, bone; bone chips with a copper dot; box art in the copper tints |
| "What you can do with RouteFlow." | 22 tinted cards with coloured icon chips | white cards on a line, ink icon on a bone tile; hover: ink border, icon tile copper; phone: rows with a plus |
| Founder note | navy gradient card with a glow | ink card, flat |
| Pricing | grey band, navy featured plan | bone band; white cards on a line; featured plan ink with a white button; bars copper |
| Questions | pale teal band, cartoon truck | white band; truck in ink and bone with the copper symbol; rows on a line |
| Last call | navy with red and blue glows | ink, flat; copper-light symbol; white button; email link copper light |
| Footer | grey | bone; logo; "© 2026 Rovio, formerly RouteFlow" |

### The other pages (one pattern each)

| Pattern today | Rovio |
|---|---|
| Top band with a blue-to-yellow gradient | white, closed by a one-pixel line |
| Cream, pink, lavender, mint bands | alternate white and bone |
| Navy panels holding white cards | ink panels, white cards on a line |
| Coloured icon chips | bone tile, ink icon |
| Yellow `mark` highlight (landing) | plain ink text (reviewers may ask for a copper underline) |
| Landing: yellow price band, cartoon people | ink band with a white button; pictures redrawn in the flat style (A-LAND: the owner may keep people) |

## 6. The wheel section

**Parts on stage:** the canvas (wheel), the words column (first-screen copy, "Look inside.", stop words,
"One system."), the legend (`.rfw-keys`), the sample card at a stop, 15 invisible tile buttons, the hover
name pill.

**Two layouts, one rule for size.**

| Layout | When | Words | Wheel box | Legend |
|---|---|---|---|---|
| Side by side | width ≥ 900 px, or a phone in landscape | left column, `clamp(320px,31%,430px)` as today | everything right of the column, inside the padding | under the sub-line: icon + name; "How you sell" one column of 5, "Your daily work" two columns of 5. When the window is under 600 px tall: names as running text, no icons |
| Stacked | narrower than 900 px, portrait | heading block at the top, centred | between the heading block and the legend | under the wheel: two groups, names as running text joined by " · " |

Size: `scale = min(boxWidth / wheelWidth, boxHeight / wheelHeight)`, centred in the box. One pose for the
open wheel on every screen, so the gaps between the three layers are the same share of the wheel
everywhere (R4, R5). If the box's smaller side is under 200 px the still picture shows, as it does
today under 500 px of height.

**What shows at each point of the scroll** (shares are today's desktop timeline, E5; the phone's differ by a few points):

| Scroll | Wheel | Words column | Legend |
|---|---|---|---|
| 0% | closed and flat | first-screen copy | hidden |
| to 36% | tilts and lifts, all three layers on one weight | first-screen copy cross-fades into "Look inside." with no empty moment | arrives with the heading |
| 36-45% | open | "Look inside." + "Buy, sell, get paid. Then buy again." | shown |
| 54%, 63%, 72% | open; the part in focus lifts (and is copper in Phase 2) | eyebrow, part name, one line, sample card | hidden |
| 76-98% | closes on one weight | "One system." + its line + "Try it with your own orders." + button, arriving as the last stop leaves | hidden |
| 100% | closed; the pin releases | same; "What each part does" follows directly | - |

On a phone the timeline starts when the stage sticks, not at the top of the page, so the wheel does not
open while the first screen is still scrolling away.

**Tiles:** icon only. Names never on the canvas. Routes and Delivery keep "If you deliver" in the stop
words and in "What each part does".
**Hover and keyboard:** unchanged: the name pill on hover, arrow keys across the 15 buttons, Enter goes
to the part. The legend is `aria-hidden`; screen readers keep `.rfw-list`.
**Focus look (Phase 2):** the tile in focus is copper with a copper-dark wall and lifts; other tiles keep
their colour (no dimming). Phase 1 keeps today's focus colours.

### Placement sign-off (WP0 gate, 2026-11-13)

apple-ux (`--quick`, 2 walkers, 1440 keyboard + 393 phone; evidence
`C:/Users/nakram/apple-ux-evidence/routeflow/2026-11-13-marketing-quick/`) and apple-design (Opus read of
this section, the code and the WP0 baseline; `local-assets/proofs/2026-11-11-rovio-rebrand/apple-design-signoff.md`)
each signed the three placements **AGREE-WITH-CHANGE**. The changes do not conflict, so nothing went to the
owner. They bind WP1.2 (brand-neutral, owner ruling 2026-11-12: it ships to master before the rebrand).

| Placement | apple-ux | apple-design | Binding change |
|---|---|---|---|
| Names in a legend, none on the canvas | Canvas names failed at both widths (phone walker could name no part) | Still text where the eye rests | **Pair a 16 px icon with each name in both layouts**, the stacked phone legend and the under-600 px one included (replaces "names as running text joined by ' · '"). Tile clockwise order in every list. Keep the per-stop heading and "What each part does". Accept: on a phone re-walk a person names 3 parts once the wheel opens. |
| Start free trial in the wheel's end state | Desktop end state is a dead end today (B1323) | Lands where the eye is as the wheel closes | **Move the existing `.sy-go` button, never add a second.** Fade with opacity only (`autoAlpha` drops it from the tab order); on `focusin` call `goTo("one")`. In reading order right after the 15 tile buttons: ≤ 2 Tabs from the last tile. On phone the header pill steps aside while it shows (no viewport with two "Start free trial"). |
| Focus ring | Today's 3 px `--b500` ring at 3 px offset (~8.4:1) was clear on every control | Copper needs a new brand colour, so it waits | **Phase 1 ships today's ring unchanged** (3 px, 3 px offset, `--b500`) and draws a 3 px `--b500` stroke on the focused tile's top face for `:focus-visible` only (today focus looks like hover). Phase 2 changes only the colour, keeps 3 px / 3 px, and drives the ink-surface ring from the panel token (copper-dark on ink is ~2.8:1), never the hand-kept selector list in `site.css:22`. |

Motion items apple-design asks WP1.2 to take (with the placements, at most these three): the snap starts
from rest after a flick (`rf-wheel-up.js:671`: use inertia and `power2.out`); phone scrub `.7` trails the
finger (≤ .3 on touch, keep .7 on desktop); `goTo` runs up to 1.6 s and fights the user's scroll
(`:777-781`: kill it on wheel/touchstart/keydown, cap near 0.9 s). The trial-button focus jump depends on
the last one.

apple-ux vital few outside the four filed bugs (report in `local-assets/proofs/2026-11-11-rovio-rebrand/apple-ux-quick/`):
polish items P03/P04/P06/P07 (393 hero ring clipped, glow and gap after the wheel, active wedge icon swap,
"Stock value (cost)") belong in WP1.2; pricing-card fit (P01), notes (F03), sign-up lead line (F05, waits on
the tier launch), header trial on /signup (P09/P10) are outside WP1 and stay in the report.

## 7. Print and no-scroll

Print uses the static layout the site already has for no scripts. Every GSAP media condition starts
with `screen and`, so entering print reverts all motion; `js-motion` comes off for the duration and the
wheel shows its still. Reveals start from visible: nothing is hidden before it is about to enter the
screen (R1, R2).

## 8. Logo, icons and share image

| Place | Kit file (copied to `img/`) | Size |
|---|---|---|
| Header on white, footer on bone | `rovio-logo-horizontal-small-colour.svg` | 112 to 132 px wide (minimum 90) |
| Any ink band | `rovio-logo-horizontal-small-colour-reversed.svg` or `rovio-symbol-colour-reversed.svg` | symbol 44 px (minimum 24) |
| Wheel hub and pictures | the reversed symbol (`symbolOnDark`), drawn with `drawImage`, copper light on ink | scales with the art |
| Tab and touch icons | kit `icons/web/favicon-48.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, saved as `rovio-mark-48/180/192/512.png` | the names avoid the banned `favicon.*` strings (E21) |
| Share image | the code-built `/opengraph-image` route, redrawn: kit logo artwork, ink on white with a bone base | 1200 × 630, same URL |

Clear space: the height of the letter o on every side. The name is never typed in place of the logo.
The site's `theme-color` stays white: the top of every page is white.

## 9. Words

The Apple-style pass (R11) works from a ledger: page, old string, new string, the rule it follows. The
owner approves the ledger before anything is applied. Claims are not changed. Seen in the audit and
worth a look (candidates, not decisions): the legend's hidden list runs label and description together
("PurchasesBuy from your suppliers"); "Counter sales" explains set-up before it says what it does;
"Sign in", "Store sign in" and "Open dashboard" should read as one family.

## 10. Accessibility

AA contrast for all text (kit table: ink on white 18.0, copper dark on white 6.4, copper light on ink
6.9, steel on white 5.9). Copper on white (4.2) only for the symbol and large text. Focus: 2 px
copper-dark ring with a 2 px offset on light, copper light on ink. Tap targets stay at least 44 px. The
`prefers-contrast: more` block is kept and re-pointed to the new names.

## 11. State set

| State | What shows |
|---|---|
| Default | §5, §6 |
| No scripts, or a browser that cannot run the wheel | static layout and still (unchanged) |
| Print | static layout (§7) |
| Window under 500 px tall | the still (unchanged) |
| Signed-in visitor | header shows "Open dashboard" (unchanged) |
| Loading, error, offline, empty, stale, concurrent edit | not applicable: static pages with no data calls except the price list, which keeps its built-in fallback text |

## 12. Review gates (people and skills, not tests)

| Gate | Skill | Signs off | When |
|---|---|---|---|
| G-U | `apple-ux` | first-time visitors can name each part, find pricing and start a trial, desktop and phone; the vital few fixes are done | end of Phase 1 and on the launch branch |
| G-D | `apple-design` | placement of legend, focus and end state; motion; copper count per screen; flatness | same two points |
| G-W | `apple-write` | the copy ledger before it is applied; the renamed strings after | WP1.3 and WP2.5 |
| G-I | `impeccable` finish review | each page against the guide at 1440, 768 and 390 px | WP2.7 |
| G-O | owner | the before-and-after proof page | before each phase lands |

## Stage log (this file's rows)

| Stage | Stop condition | Fired? | Action |
|---|---|---|---|
| P5 UX | a new component where an existing one could do | yes | the on-stage legend reuses `.rfw-keys`; the end-state button reuses `.sy-go` |
| P5 UX | a token invented that the repo has | no | new names are jobs; every retired name is listed |
