# UX spec — auth shell (auth-redesign)

Design of record: the redesign source's `components/auth-preview.tsx` + `app/workspace.css:13-300`
(READ-ONLY). Repo design system: `.claude/pipeline/design-system.md` and the marketing tokens in
`apps/web/app/(marketing)/marketing.css:20-60`. The auth look is scoped to `.rf-auth`; it reuses the
root layout's font variables (`--font-geist-sans`, `--font-geist-mono`) and the brand components
(`Brand`, `BrandMark`, `BrandSignature` from `@/components/brand`, plain `<img>`, `tone="light"` on navy).

## Layout

```
<main id="main-content" class="rf-auth">                  grid 1fr 1fr · min-height 100svh · bg #fff
  <section class="rf-auth-story">                          bg #10264d · color #fff · padding 38px 50px · flex column · space-between · overflow hidden
    <Brand tone="light" />                                  top-left, links to "/"
    <div class="rf-auth-story-copy">
      <span class="rf-kicker">For distributors</span>        uppercase via CSS · letter-spacing .12em · 12px · #ffffff (ambient, 14.9:1)
      <h2>A clearer picture of your business.</h2>           clamp(2rem,3.2vw,3.5rem) · lh 1.08 · ls -0.05em
      <p>…verbatim paragraph…</p>                            #c2d0e5 · max-width 400px (copy block itself: max-width 540px)
    </div>
    <div class="rf-auth-orbit">                              glass card · rotate(-2deg) · radius 25px · shadow 0 30px 65px #0003 · blur 14px
      <div> Order RF-1042 · Ready for the next stop. <div class="rf-auth-track"><i/><i/><i/><i/></div> Order → Route → Delivery → Invoice </div>
      <div class="rf-auth-ai"> AI purchase-invoice scanning · Multiple vendors. Easier inventory and costing. </div>   bg #eee2fa · color #623691 · rotate(3deg) · radius 20px
    </div>
    <span class="rf-auth-bottom">One brand. One connected workflow.</span>
  </section>
  <section class="rf-auth-form">                           padding 36px 8% · flex column · space-between
    <a class="rf-back" href="/">← Back to website</a>       14px · #616b7c · hover #10264d
    <div class="rf-auth-card">                             max-width 420px · margin 50px auto
      [tenant logo <img> when logoUrl]                      height 40px · margin-bottom 16px
      <span class="rf-kicker">Distributor workspace</span>  uppercase · #292c33 (`--rf-charcoal`, ambient, 14.0:1)
      <h1>Welcome back.</h1>                                2.4rem · ls -0.05em · lh 1.1 · #10264d
      <p class="rf-auth-lead">…</p>                         #616b7c · 15px
      {children}                                            the page's existing form / states
    </div>
    <div class="rf-auth-footer">{footer}<a href="/contact">Need help?</a></div>   13px · #616b7c · links #10264d
  </section>
</main>
```

Retailer audience swaps the story copy (`For retailers` / `Stock your shelves. Stay in control.` / its
paragraph) and the card kicker (`Retailer account`); everything else is identical — one palette for both
portals (the redesign's decision; the buyer portal itself stays emerald after sign-in).

## Tokens (scoped to `.rf-auth`)

| token           | value     | use                                                             |
| --------------- | --------- | --------------------------------------------------------------- |
| `--rf-navy`     | `#10264d` | story bg, h1, primary button                                    |
| `--rf-charcoal` | `#292c33` | body text on white; card `.rf-kicker` (ambient, 14.0:1)         |
| `--rf-teal`     | `#087c78` | track segments accent (`#76d2bb` light variant)                 |
| `--rf-plum`     | `#623691` | AI chip text (bg `#eee2fa`)                                     |
| `--rf-muted`    | `#616b7c` | lead, footer, back link                                         |
| links           | `#0b6e6b` | anchor/Link text — the operator link utility (6.07:1); not navy |
| story muted     | `#c2d0e5` | kicker/paragraph on navy (contrast 9.6:1)                       |
| field border    | `#d7dce4` | inputs; bg `#fafbfd`; focus border `--rf-navy`                  |
| success panel   | `#def5ee` | `.rf-auth-success` (radius 20px, padding 24px)                  |
| error banner    | existing  | keep the pages' current `bg-danger-bg` classes                  |

Radii: inputs/buttons 12px, cards 20–25px. Buttons: `.rf-btn` min-height 44px, padding 12px 20px,
600 weight, navy bg → hover `#203d68` + `translateY(-1px)` (none under reduced motion); `.secondary` =
white bg, navy text, `1px solid #d7dfe9`; `:disabled` opacity .5.

## Responsive

`@media (max-width: 850px)`: `.rf-auth { grid-template-columns: 1fr }`; `.rf-auth-story { min-height:
auto; padding: 24px }` showing only the brand row; `.rf-auth-story-copy, .rf-auth-orbit, .rf-auth-ai,
.rf-auth-bottom { display: none }`; `.rf-auth-form { min-height: calc(100svh - 90px); padding: 24px }`;
`.rf-auth-card { margin: 36px auto }`; `.rf-auth h1 { font-size: 2rem }`. Between 851 px and 1100 px the
story padding drops to 28px 32px so the h2 never wraps past four lines.

## States (all inherited from the pages; the shell adds none)

Empty/loading/error/success/disabled/unauthorized as the pages implement them today; the shell only
frames them. Success containers add `rf-auth-success`. No motion anywhere except the button hover.

## Accessibility

One `h1` per page; `main#main-content`; labels remain real `<label htmlFor>`; `aria-invalid` +
`aria-describedby` on the shared inputs; visible focus (`outline: 2px solid var(--rf-navy); outline-offset:
2px` for `.rf-auth :focus-visible`); the decorative order card and AI chip are `aria-hidden="true"` (pure
decoration; the same claim is made in the marketing copy); the story h2 is real text, readable by AT.
Contrast: white on `#10264d` 13.9:1; `#c2d0e5` on `#10264d` 9.6:1; `#616b7c` on `#fff` 4.8:1;
`#623691` on `#eee2fa` 6.2:1.

## Verification

Playwright spec 46 captures `test-output/auth-redesign/<route>-<viewport>.png` for the Opus judge; the
engine's UI verify drives `http://localhost:3009` (a `next dev -p 3009` of THIS worktree — prove the branch
build first: the response must contain `rf-auth`) at desktop 1280×800 and 375×812 with reduced motion,
reading console, network and axe.
