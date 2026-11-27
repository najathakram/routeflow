# Wheel code map (origin/master copy, site/)

Paths relative to `site/`. JS = `graphics/rf-wheel-up.js`, WCSS = `graphics/rf-wheel-up.css`, HU = `js/home-up.js`, HUC = `css/home-up.css`. Read-only; section 9 = hypotheses, not runtime measurements.

## 0. Surprises vs the brief
- The live wheel is a single `<canvas>` with a hand-rolled 3D projection (tilt 68, perspective 2000, extruded plates), not SVG. SVG exists only as the no-JS still (`dial()` JS:86; baked into home.html:114).
- `js/site.js` is NOT loaded by home.html (scripts home.html:646-649: gsap, ScrollTrigger, prices, rf-wheel-up, home-up, auth-nav). Home reveals live in HU. SplitText is not loaded.
- A legend already exists below the wheel: `.sy-parts` (HUC:104-112), shown only when the wheel is live.
- No `@media print`, `prefers-reduced-motion` or `color-scheme` anywhere (grep); "the motion always runs" (JS:227, HU:6).

## 1. Build
- `home.html:114` `<div data-scene="wheel" data-copy=".hx-copy" class="rfw rfw--static">` holds the still SVG + `.rfw-stage` lists. `mount()` (JS:204) replaces it via `liveHTML()` (JS:134-139): `.rfw-pin > .rfw-tile > .rfw-cvw > canvas.rfw-cv`, 15 invisible buttons `.rfw-b`, `.rfw-tok`, `.rfw-tip`, `.rfw-words` (hint, `.rfw-h.h0/h1`, per-stop `.rfw-s` via `stopHTML()` JS:133), SR-only `.rfw-list`. `still()` JS:222 is the fallback when gsap/ST/matchMedia/Path2D/ResizeObserver is missing (JS:218).
- Data: `OUTER` 10 / `INNER` 5 JS:20-38; `ICON` JS:51-67 -> Path2D `icd()` 68; `outline()` 163; `WD` 292-295.
- Draw (inside `live()` JS:269-951): `proj` 327; tiles+sides `plates()` 388-493 (top face 402, walls 332-338); hub 494; `draw()` 529; `tick()` 828.
- Constants (wheel units, outer radius 480): `R0=250,R1=480,r0=128,r1=236,HUB=116,GAP=7` JS:74; `THO=40,THI=34,THH=58,DEPTH=2000,FS=46,FSI=62,LF=48,TILT=68,YC=-260,DRIFT=.05` JS:182; explode `EXD={o:190,i:104}`, phone `EXP={o:92,i:52}` JS:185; layer heights `POSE_D` apart -160/350/620 story -170/390/720, `POSE_P` apart -200/400/800 story -170/300/680 (JS:186-187).

## 2. Size and position
- CSS: `.rfw{height:calc(100svh - --rfw-top + 100svh*--rfw-run)}` (WCSS:2-3), run 3 wide / 2 narrow (WCSS:88-89). `.rfw-pin` is sticky, `top:--rfw-top`, `height:100svh - top` (WCSS:7-8). `.rfw-tile` inset `--rfw-gy=clamp(8px,2.2vh,24px)`, width `min(1640px,100% - 32px)` (WCSS:2,10). `--rfw-top` = sticky header height via `headerTop()` JS:211-217; HUC:6 hard-codes `--hx-bar:68px`.
- The wheel has no CSS size. Canvas = tile size (JS:628-637). Scale/position come from `fitTo(bb, box, wMax)` JS:572-575: `k=min(boxW/bbW, boxH/bbH, wMax/bbW)`, centred; `bboxOf()` JS:561. `layout()` JS:577-649 reads `tile.clientWidth/Height` (580), re-run on ST `refreshInit` (909) and `ResizeObserver(tile)` (878). Window height enters only via the `100svh` tile, never `min(vw,vh)`.
- Wide branch JS:614-626: `pad=clamp(28,56,W*.042)` (583); words column `.rfw-h` width `clamp(320px,31%,430px)` (WCSS:26); `side={l:colR+gap,t:pv,r:W-pad,b:H-pv}`, `pv=pad` unless `brief&&H<480` (618). Closed: `F.flat=F.end=fitTo(flatBB,{...,b:H-pad-28},H*.74)` (619). `F.burst` = whole tile (622); `F.apart`, `F.story` fit the tall exploded stack into `side` (623-624).
- Phone branch JS:589-613: hero words are in the page above the stage; `F.flat` bottom `clamp(low,H-14,vis-40)`, `low=min(W*.72,460)+14` (592-594); `F.apart/burst/story` loop `u` 1 to .55 shrinking `POSE.*.z*` until the wheel is >=84% of `W-16` (597-613), changing layer gaps per layout.
- Modes (JS:229-230): `wide (min-width:900)`, `land (max-width:899.98 & max-height:599.98 & min-aspect 1/1)`, `low (max-height:499.98)`; `phone=!wide&&!land`; `small=phone||low||land`; `brief=small` (271-273).

## 3. Triggers and timeline
Wheel, `link()` JS:667-677: `ST.create({animation:T, trigger:el, start:0, end:"bottom bottom", scrub:0.7, snap:{snapTo:nearBeat, duration:{min:.35,max:.8}, delay:.3, inertia:false}, refreshPriority, onRefresh:mark})`. No ST pin (CSS sticky, WCSS:6-7): no pinSpacing/anticipatePin/invalidateOnRefresh. One `gsap.matchMedia(el)` (JS:228-231); a breakpoint change reverts and rebuilds all.
- `start:0` is page scroll 0. Desktop: stage at top (hero copy is an absolute overlay, HUC:9-10), aligned. Phone: hero copy is in flow above the stage, so the timeline runs before the stage sticks (JS:188-190).
- Distance = `elTop - top + run*100vh`: desktop 300vh, phone 200vh plus hero copy height. Sticky releases exactly when the timeline ends.
- `planOf()` JS:193-196 (units): T_OPEN 6.7, T_APART 7.7, T_SEEN 8.3. Desktop STOP 1.6: stops 10.1/11.7/13.3, close C0 14.1, END 18.6. Phone STOP 2: stops 10.3/12.3/14.3, C0 15.3, END 19.8. Scroll share (desktop/phone): T_OPEN 36%/34%, T_SEEN 45%/42%, stops 54-72%/52-72%, C0 76%/77%, last visible tween ends C0+4.13 = 98%/97% (JS:763-764).
- Phases: tilt 0.05 (690); layers 0.7/1.1/1.3 x 5.2 (692-694); fly-out 1.1-3.5 (699-701); names in at `at+late`, out T_SEEN+0.1 (703-704); `hx[0]` T_OPEN+0.1..T_SEEN (708-709); camera `wS` T_SEEN+0.05 (711); stops orders/inventory/payments (42, 719-749); close from C0 (753-766); `hx[1]` C0+2.9 (767); filler to END (768).
- `nearBeat` 660-666: no snap in (0.15, T_OPEN-0.5) and (C0, END-1.1); else nearest of rest, apart, 3 stops, `one` at END-0.3.
- Other triggers (HU:111-139): `gsap.matchMedia` per section, desk = `(min-width:900)&(min-height:600)`; pins: problem `+=170%` (179), journey (251), shot `+=115%` (315), sell `+=85%` (360); rest `play none none none` / `ST.batch` `top 104%`.

## 4. Layer gaps (B2)
- Weights `S.lH, S.lI, S.lO` (0..1, unitless), staggered starts, same HEAVY ease (JS:692-694). `pose()` JS:378-386: `cam.zO = lerp(lerp(lerp(0,A.zO,lO),B.zO,wS),0,hO)`, same for zI, zH. The gap between layers is the difference of three separately eased lerps, retargeted at `wS`.
- Units are wheel units, not px/vh/%. Screen gap = dz * cos(tilt) * perspective * K, with K and tilt themselves interpolated (`cam.k`, `cam.tilt=TILT*wA*(1-wE)`, JS:383-385). Not function-based tweens: `layout()` refits `F.*` on refreshInit/RO, `draw()` reads them per frame (286-287).

## 5. Labels and legend
- Names are `d.t` drawn with `ctx.fillText` in `plates()`; no DOM labels. Hover pill `.rfw-tip` (JS:556-557, 782-785) shows the hovered piece when `!P[i].nd`.
- Outer tiles JS:416-452: `name=max(!phone&&size>=13?flat:0, p.n)`; `flat` is 1 only untilted (rest), `p.n` is 1 between `at+late` and T_SEEN+0.1. At the three stops no tile has a name. Fit: shrink to the wedge width at 5 scanlines (430-439), floor 11 px (small) / 10.5 px; `shy=small&&fitN<floor` (441) hides a name only on small screens, else the floor size is drawn and can overflow (442).
- Inner tiles never carry names on the plate; the label hangs in the air (453-479): left/right if `|ux|>.7`, above the back if `uy<0`, else at the inner edge `r0+sl` (454) drawn upward from that point (475), i.e. over plates/hub. Counter sales (index 3, 126 deg, front-left) takes the front path. The `out` collision fix (465) and drop rule (470) run only when `brief`/`small`.
- Legend: `.rfw-keys` only in the still (hidden live WCSS:61); `.rfw-list` SR only (60); `.sy-parts` below the wheel when live (HUC:104-105). None on stage.
- Headings: `.rfw-h.h0` "Look inside." T_OPEN+0.1..T_SEEN; `.rfw-h.h1` "One system." from C0+2.9; `.rfw-t` per stop (723-729).

## 6. Hidden states (B4)
- CSS before JS: `.js-motion .reveal{opacity:0}` (css/site.css:133). `.js-motion` is set by an inline head script on every load (home.html:27), removed only if gsap is missing after 2.5 s; HU `section()` re-adds it, never removes it (HU:132). `.rfw-h,.rfw-t,.rfw-card{visibility:hidden}`, `.rfw-t,.rfw-card{opacity:0}` (WCSS:31-32). Pinned layouts exist only under `.js-motion` (home.css:411-428, 621-667), incl. `.pb-big{position:absolute;inset:0}` (417), `.ans-i--v/--p{visibility:hidden;opacity:0}` (642-643).
- Phones: `animation:rf-rise ... both; animation-timeline:view()` leaves off-screen h2s at translateY(22px) (mobile.css:49-52); `.inc-ic`, `.fq-art` likewise (home-color.css:104-109).
- JS: hero `g.from(opacity 0)` HU:169; `revealOnce` (opacity 0, `ST.batch` at `top 104%`) 150-156; `settle` 158; `closer` 433; founder 460; pricing 473; others `fromTo(opacity 0)` 180-410; wheel `g.set(autoAlpha 0)` and canvas `arrive` opacity 0 (JS:680-683, 772). Below-fold content stays at opacity 0 until scrolled to.
- No-JS shows the final state (static SVG, `html:not(.js-motion)` grid, HUC:24-31). Reduced motion and print: no code path.

## 7. Colour and effects
- Tile colours are hand-picked hex in JS data (`c` face, `w` darker side wall, `i` icon ink; JS:17-38), not derived at runtime; duplicated as `--pc-*` in css/home-color.css:6-7. Runtime face = `mix(white|#fafafc, c, max(p.c, REST_TINT .4))` (JS:179,398), wall = `mix(#d6dee8, w)`, muted toward `#e2e8f0` when another piece is in focus (397,400); hairline `rgba(INK,.08)` (403); focus ring `#2b4c88` (406); hub `#10264d` (180).
- Gradients: three canvas radial shadow sprites (JS:301-311); shadowBlur on white names (447); CSS shadows `.rfw-tip` (WCSS:18), `.rfw-card` (37). No `--rf-*` colour is read in the canvas; stage fill = tile bg (638).

## 8. Resize and fragile spots
- Resize: RO on tile (JS:878), ST `refreshInit` (909), matchMedia rebuild (901-925). `ignoreMobileResize` (HU:100) while the pin uses `svh` (WCSS:3,8).
- Magic numbers: label offsets 12/16/24/54 (JS:426); floors 11/10.5/9 (438,463-471); `late` switch at tile height 520 (697); `H*.74`, `-28` (619); `pv=H*.04` under 480 (618); 0.84, u>=.55 (603,612); `--hx-bar:68px` (HUC:6). WCSS:88 uses `899px`, JS `899.98px`.
- Short-screen protections (`shy`, `drop`, `out`, `late`, `pv`) key on `small/brief` (JS:271-273): false at >=900 wide and 500-599 tall (1288x593).

## 9. Hypotheses
**B1 (1288x593).**
- H1a: open-wheel box is `H-2*pv` (about 390 of 499 px; `pv=pad` since `brief` is false, JS:618) and the exploded 3D stack is tall, so `k` collapses (JS:572-575,623-624); POSE is scaled by `u` only on phone (598-613).
- H1b ("top corner"): `F.*` defaults `{k:.4,x:0,y:0}` (JS:314) sit at the canvas origin; shown if `layout()` returned early (JS:581) or `fitTo` gave NaN. First pass reads `hx[0].offsetLeft` before `--rfw-l` is set in the same call (616-618). Not determined.
- H1c: Counter sales over tiles: front inner label anchored at the inner edge, drawn upward (JS:454,475); collision/drop guards need `brief` (465-471).
- H1d: "one named": names exist only at rest/apart (JS:416,703-704), need `size>=13` at rest; may be the hover pill (556,782) or a piece mid-fade (699-703). Not determined.
- H1e: half empty: the words column stays reserved (`side.l=colR+gap`, 623-624). Needs runtime `F.*`, `tile.clientHeight`.

**B2 (phone).**
- Gaps: three staggered eased lerps (JS:692-694) under a moving camera K/tilt (383-385), retargeted at `wS` (711), per-layout `u` shrink (598-613); timeline also starts before the stage sticks (`start:0`, 669).
- Heading missing: no heading from the last stop's hide (JS:728) to `hx[1]` at C0+2.9 (767), about 3 units (about 15% of scroll); also T_SEEN to first stop (709 vs 724) and before T_OPEN+0.1 (708).
- Names vs icons: per-tile 11 px floor (441,449,470), back tiles narrower. Needs runtime `cam.z*`, K at 390x844.

**B3.** Sticky releases when the timeline ends (WCSS:2,7; JS:669); the white stage on a white page (WCSS:10) then scrolls off one pin height before `.sy-go` (home.css:372, one line + button). Timeline tail only 0.37 unit; "One system." visible about 8% of scroll; snap `delay:.3` and `nearBeat` (662) can park scroll in the last 1.1 units. Phone: `svh` pin vs visual viewport (HU:100)? Not determined.

**B4.** Opacity 0 set by JS for all below-fold content and revealed only by scroll (section 6); `.js-motion` never removed; no print/reduced-motion path. Overlap: phone `rf-rise` leaves an unscrolled h2 22 px low (mobile.css:50-52) vs `h2+.sub` gap 12 px (mobile.css:20); `.js-motion .pb-big{position:absolute}` (home.css:417) overlays the problem lines when pinned CSS applies but the timeline has not run. "Dark text on black": unexplained; hero bg is white (home.css:117); black sources are `.pb` (home.css:138) and the opaque canvas (`alpha:false`, JS:281) before first draw (632-635). Needs a render of the failing capture.
