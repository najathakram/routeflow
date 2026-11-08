# Web landing 2026-11-06 (bookkeeping filed 2026-11-07), slipped windows (merge `ce0ed80a11`, range `266095419c..ce0ed80a11`)

Paths under `apps/web/`. Two code PRs touched web: the S1-sweep train #4233 (`de91a1eb37`; members #4209 and #4210) and the site fix #4234 (`7b36e3a630`). No mobile source changed (one test mock changed, the api error-code parity list).

## #4233 train, web parts

- **Courtesy badge outranks the source (#4209 `9910b5090a`, SA-1099 A-2 N1).** `app/(platform-admin)/admin/tenants/[id]/_features/badge.ts` `deriveBadge` returns "courtesy" ("Not enforced yet", amber) for a row served by the dark-gate courtesy (`detail.term === "courtesy"`) ahead of the source; `types.ts`, `preview-groups.ts` and `PreviewDrawer.tsx` change with it; specs `badge.test.ts`, `preview-groups.test.ts`, `PreviewDrawer.test.tsx`.
- **"Already have" sentence in the add-on confirm sheet (#4210 `0e6e738b1c`, WP5).** `app/(dashboard)/settings/billing/page.tsx` shows the sentence for a held add-on; `lib/api/billing.ts`, `packages/types/api/billing.ts` and `features.ts` are touched; `billing-page.already-have.test.tsx` pins it. The new `ADDON_ALREADY_INCLUDED` code is in `packages/types/api/error-codes.ts`; `apps/mobile/__tests__/__mocks__/@routeflow/types.js` follows.

## #4234 `7b36e3a630` home founder card and the wheel tile (W-1162)

- **Founder note card.** `public/site/css/home-up.css` `#founder .fd-in` is `width: min(1200px, 100% - 48px)`, centred, with a fixed clamp padding; its old side padding was a percentage, which resolves against the parent width and squeezed the text on wide screens. The no-JS hero (`html:not(.js-motion) .hx-up`) drops the same half-gap padding and its 1640px stage for the content width.
- **Wheel gradient tile removed.** `--hero-wash` and its rules (`home-color.css`), the tile and static-fallback backgrounds (`home-up.css`, `graphics/rf-wheel-up.css`) and the WASH painter in `graphics/rf-wheel-up.js` are gone; the stage is plain white.
- **Pins.** `app/(marketing)/site-founder-card-width.static.test.ts` (card width, and a scan of `public/site/css` and `public/site/graphics` for a percentage half-gap padding; its reach is one spelling, B1294); `site-color-and-life.static.test.ts` and `site-mobile-pass.static.test.ts` now assert the wash is gone.
