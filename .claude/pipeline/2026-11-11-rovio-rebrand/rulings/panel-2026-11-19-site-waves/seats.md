# Seats · SA-1174 site rebrand wave 2/3 questions · Quick · 2026-11-19 · tree head c5d9f99700

Seats: Architect, Bug skeptic and User advocate, each Opus @high, read-only, ruling blind from pack.md. The seat agents are gone; this is the record. Brand-free.

## Agreement map
| Item | Architect | Bug | User | Chair |
|---|---|---|---|---|
| OQ-1 | drawImage, plus a `symbolOnDark` key | - | - | drawImage + the key |
| OQ-2 | - | - | three new lines | owner box, User wording first |
| OQ-3 | grant 2.1b-last; also give it T21 | - | - | as Architect |
| OQ-4 | S2 = comments; the tags go to 2.3-inner | - | - | as Architect |
| OQ-5 | reverse: a ledger change in each lane's own commit | reverse: no lane lands red | - | reverse (both) |
| OQ-6 | swap the row in the same commit | - | - | yes |
| OQ-7 | one owner per css file; 2.1b ships the band roles in W2 | - | - | as Architect |
| OQ-8 | header lane takes all of home-up.css plus home-up.js:64 | T48a assertion wrong | - | as Architect + Bug |
| OQ-9 | - | B3 takes the strings + 6 pins | switch with the provider app names | B3, timing in the owner box |
| OQ-10 | - | FALSE in code; delete; narrow the rule | (c) "Email us... we'll help you choose" | delete; (c) is also untrue (Bug fact) |
| OQ-11 | rename to a neutral name | rename, keep the `-budget.static.test.ts` suffix | - | rename, keep the suffix |
| PC-1 | 2.1b, `mobile.css:42` | - | 2.1b, `mobile.css:42` | 2.1b |
| PC-2 | plain test-plan ids; cite e2e 36 as `36:T##` | prefix every id | - | as Architect |
| PC-3 | exact paths and tests; "unedited" = empty diff | - | - | as Architect |
| T46a | - | cannot go red | - | rewrite to P01's real defect |
| T46b | - | define Tab-Enter-Tab | green today? observe | define, and prove red at base |
| T48a-d | - | a wrong, d guard-only | - | fix a; d gets a fault injection |

## Vetoes
- **Architect:** a Path2D path held in `brand.json` (it breaks the swap rule).
- **Bug:** T46a as written (it cannot go red), and OQ-5's "red until close-out".
- **User:** none, but objects to keeping `product.html:303` as written.

## Seat facts adopted
- **A1:** the kit symbol SVGs carry an intrinsic size and are same-origin. The hub on ink needs the reversed symbol's colour, and `brand.json` has one `symbol` only (ux-spec:189).
- **A2 / B2:** master's site-pins guard checks pins now + rows == baseline exactly (`site-pins.static.test.ts:82-87`). Additions and deletions both go red, and edits are invisible. The branch has no site-pins test until step 0. The branch's ledger has 3 rows and master's has 36. `site-color-and-life` counts 29 against a baseline of 26 after 2.1a, so step 0 may go red. Observe and report.
- **A3:** the only band rule is `.section.alt` (`site.css:80`); the tints live in `mobile.css:36,39,43`.
- **A4 / B5:** `hero-btn-in` is toggled only for the hero (`js/home-up.js:64`). `SiteFrameHeader.tsx:53` hard-codes it.
- **A5 / B3:** site-pins `e2eTitles` scans only e2e 36, 84 and 85, matching `^T\d+$`. A `replacedBy: "T19"` row passes on e2e 36's unrelated test; `T46a` and `T48a` can never pass.
- **B1:** a downgrade frees every ACTIVE OPERATOR and DRIVER not in `retainedUserIds` (`billing-cron.service.ts:543-567`, verified by the chair at `:555-560`). The web always sends `retainedUserIds: []` (`apps/web/lib/api/billing.ts:467`, verified). TENANT_ADMIN is kept.
- **B4:** no support path sets `retainedUserIds`: the downgrade route is `@NoImpersonation("billing")` (`settings-billing.controller.ts:204`). So the in-app warning "Contact support before then to choose which users to keep" (`subscription-mutation.service.ts:1288-1290`) is not true in code.
- **B6:** `.pcard` is a flex column and `.pbtn{margin-top:auto;width:100%}` (`site.css:183`, verified), so the button already sits at the card's content bottom. P01 is "button at card bottom, empty fill" (context-pack:76, verified). T46a as written asserts the defect.
- **B7:** the mailbox pins that would go red: `mailbox-connection.service.spec.ts:578`, `MailboxCard.test.tsx:61,65,481`, `e2e/mailbox-connect.spec.ts:89,92`, and the `MailboxCard.tsx:178` comment.
- **B8:** e2e 36 has a third `T21` (motion, `36:1383-1677`).
- **U1:** T37 fails on the name followed by `.!?` (`site-copy-rules.static.test.ts:110-114`), so "What is X?" fails too. "What does X do?" matches `pricing.html:137`.
- **U2:** the share-image alt is `{{brand:name}}. {{brand:shareLine}}` on every page, the double-stop risk for a dotted name.
- **U3:** the provider consent and app-list names (Google OAuth consent screen, Microsoft app registration) are missing from the D0 console list (spec-delta:61,85 cover only the origin).
- **U4:** the wheel sub line lives in two places (`home.html:114`, `rf-wheel-up.js:47`).
- **U5:** `#main` opens on the plans (`pricing.html:92-96`), so T46b may already be green. Observe and report.

## Private
None.
