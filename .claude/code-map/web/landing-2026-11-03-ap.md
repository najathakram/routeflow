# Web landing 2026-11-03, train ao (merge commit `f10b57ce34`, range `f9f1a592ed..f10b57ce34`; train PR #4180, head `6acccdb660`)

Web paths under `apps/web/` unless they start with `apps/api/`, `apps/mobile/` or `packages/`. Members: #4177 (docs), #4178 `a6f366d6e5`, #4175 `84c9ae766d` (api only), #4130 `8f4a144273` (api side in `api/landing-2026-11-03-ap.md`). No migration, no new env var. Tests are names only; they were not run for this note.

## #4178 `a6f366d6e5` the desktop wheel stops repeating a piece's name in a pill

Rule: the hover/focus label (`.rfw-tip`) shows only for a piece whose own name is not drawn this frame; a name on the tile or beside it means no label. Inner pieces at rest on desktop (icon only), any piece at phone or tablet width at rest, and a name left out because it would not fit keep their label.
- `public/site/graphics/rf-wheel-up.js`: each piece records `p.nd` where its name is drawn; the label's `on` class follows it on arrival and every frame. No word, size, colour or timing of the wheel changes.
- Tests: `e2e/36-marketing-site.spec.ts` T24 (1440 x 900 pointer and keyboard focus; 768 x 1024 and 390 x 844 keep the label), `app/(marketing)/site-mobile-pass.static.test.ts` (one new pin).

## #4130 `8f4a144273` the first-pack question (W-867)

- `components/PackReadingAsk.tsx` (new): "Your stock shows 240. Is that 240 boxes or 240 pieces?" with the Boxes and Pieces answers; `components/PackSizePrompt.tsx`; `app/(dashboard)/products/[id]/page.tsx` and `app/(dashboard)/products/page.tsx` (Quick Edit pack cell) send the save first, open the question on the server's 409 `PACK_READING_REQUIRED`, and re-send the same save with the answer (including `moveVariantIds`). The list's Quick Edit pack cell now stops its click from opening the product (the question lives on the list page). `lib/generic-toast-copy.ts` and `lib/mutation-error-toast.ts` word `RECEIVED_BEFORE_PACK`, `PACK_OPEN_LINES`, `PRODUCT_IN_OPEN_COUNT`.
- Tests: `components/PackReadingAsk.test.tsx`, `components/ProductCreateModal.k12-o1.test.tsx`, `app/(dashboard)/products/[id]/page.k12-o1.test.tsx`, `app/(dashboard)/products/quick-edit-pack-wiring.static.test.ts`, `lib/generic-toast-copy.test.ts`, `e2e/units-v2-pack-intro.spec.ts`.

## #4175

- No web source; see the api note.
