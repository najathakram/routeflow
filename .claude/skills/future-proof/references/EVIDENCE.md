# Evidence: why the gate exists, and what each check catches

Sources: the Opus review and check files of 2026-10-08 (`local-assets/specs/sa-7xx-review-*.md` and
`*-check-*.md`, which are machine-local and not in git), the approved SA-729 to SA-756 specs, and the
10-08 work plan. Security findings are named only at the level of their pattern; their details stay in
the private review files.

## Baseline: before the gate

| Spec chain | Verdicts to APPROVED | FAIL | What the must-fix findings looked like | Checks that would have caught them |
| --- | --- | --- | --- | --- |
| SA-732 (security spec, private) | 5 | 4 | security spec (private) — pattern: a design patched finding by finding instead of choosing one that holds; host capacity assumed, not measured | G3 signal, G1 |
| SA-733 billing go-live | 4 (then a fold) | 4 | a new "paused" state added without listing every path into and out of it; values decided at session creation but used at completion; the dark-to-enforced flip acting on a backlog with no notice; red rows already green on master; folds opening new must-fix findings | G4, G5, G3 signal |
| SA-736 100% coupon | 2 | 2 | "every consumer follows automatically" was false (about 15 sites); a row read before the transaction; a second writer | G4, G5, G1 |
| SA-743 (security spec, private) | 2 (then a fold) | 2 | security spec (private) — pattern: a premise the design relied on was not true at master; the inventory of affected sites grew between rounds | G1, G4 |
| SA-744 RF invoice windows | 2 (then a fold) | 2 | invoices issued ahead under the old window shape; mislabelled legacy rows; one rule that had to agree with SA-733 | G5, G1 |
| SA-749 split payment | 2 (then a fold) | 1 | held attempts made before the deploy, replayed after it; an identity taken from the client instead of built on the server; red rows already 400 on master | G5, G4 |
| SA-750 end-of-day close | 2 (then a fold) | 2 | a calendar day used as the key instead of a cutoff window; a sale committing during the close; expected cash drawn from the wrong population | G2, G5, G1 |
| SA-756 (security spec, private) | 1 (then a fold) | 1 | security spec (private) — pattern: a default applied per call site; a pin scoped by a list of files | G4 |
| **Total** | **20** | **18** | **all 8 first reviews FAILED**, an average of 2.5 verdicts per spec | |

## The ten classes

**A. Ground truth assumed, not read** (caught by G1). A field, state, writer or environment fact the design
needed was not true at master or on the machine.
- SA-743 (security spec, private) — pattern: a premise the design relied on was not true at master.
- SA-749 assumed a payment field that the writer never sets and no DTO carries.
- SA-736 assumed a predicate that takes no subscription argument, with about 15 callers that do not select
  the new field.
- SA-733's design contradicted a pinned predicate and a reinstatement path, and misread the invoice
  shape at the pinned API version.
- SA-732 (security spec, private) — pattern: host capacity and platform facts were assumed instead of
  measured.
- SA-750's query population included payments the till never took.
- Lessons: L-125, L-169, L-204.

**B. Per-site fix where the class needed one helper and a pin** (G4).
- SA-733: every path back to ACTIVE must clear the dunning fields. The fix was one helper plus a pin.
  Each round then found another exit path, so the pin had to cover every status writer.
- SA-743 (security spec, private) — pattern: one helper plus an inventory pin over every call site,
  defined by a code predicate.
- SA-736: a required argument, so that the compiler finds all of about 15 sites.
- SA-756 (security spec, private) — pattern: the pin's scope is a code predicate, not a list of file
  names.
- Lessons: L-167, L-171, L-189.

**C. Red rows not red on the value** (G4).
- SA-733r: five rows were already green on master.
- SA-736: rows failed on a compile error or an unknown column, and one mock ignored `where`.
- SA-744: a property test was already green; it is a guard.
- SA-749: rows were already 400 for an unknown field.
- SA-750: the rows had to assert values.
- Lesson L-205, and fleet-lead §6 ("observe, don't predict").

**D. Decided at one moment, used at another** (G5).
- SA-733: the anchor and the catch-up were decided at session creation and settled at completion; a
  redelivered event re-stamped a paid invoice.
- SA-736: a row was read before the transaction; concurrent webhooks needed a sync-time compare-and-set.
- SA-750: a sale could commit during the close.
- SA-749: a retry could arrive with changed legs.

**E. Old shape meets new code** (G5).
- SA-749: held attempts from before the deploy were replayed after it.
- SA-744: invoices had been issued ahead under the old window shape, and some legacy rows were
  mislabelled.
- SA-743 (security spec, private) — pattern: old data needed a dual-read until a hard date.
- SA-733: the dark-to-enforced flip would act at once on everything that had piled up.

**F. A narrow model where the domain needed the general one** (G2, G3).
- SA-750: the key was a calendar day, so the windows became cutoff to cutoff, with the day kept only as
  a label. It is still a single till.
- SA-748: business state was kept on one browser.
- SA-747: the ranking was counter-only, under a counter-named setting.
- SA-749: the identity came from the client. The fix is a server-built UUIDv5 of the owning ids.

**G. Patching a boundary instead of choosing one that holds** (the G3 signal).
- SA-732 (security spec, private) — pattern: four FAIL rounds of patching instead of choosing a design that holds.
- SA-733r: folding owner rulings into the spec opened six new must-fix findings in one round.

**H. Unsafe defaults** (G4).
- SA-756 (security spec, private) — pattern: one helper + an inventory pin over every call site.
- SA-732 (security spec, private) — pattern: an unknown outcome must resolve to the safe answer.
- SA-733r2: a failed re-read of the third-party state must refuse.
- Lesson: L-202.

**I. Rules keyed on a label instead of the state of record** (G2, G5).
- SA-733r: refuse because an owed invoice is unpaid (re-read it), not because of a reason string.
- SA-733r2: an allow-list keyed on a reason string blocked a cancelled tenant from paying. Key it on the
  owed-invoice marker instead.
- The positive shape is `capabilities.fulfilment`: every rule reads the derived answer.

**J. Cross-spec inconsistency** (G1).
- SA-744r had to amend SA-733 so both use one contiguity rule.
- SA-750 depends on SA-740 and SA-738.
- The SA-741 bundle had to follow the key change in SA-750r2.

## Good shapes to copy

- **SA-729 units.**
  - Chained entry with flat storage: `factorToBase` stays the only source of the math.
  - Snapshots on lines are never retroactive.
  - Names are archived, never deleted.
  - A helper (`baseLabelOf`) replaces a constant.
  - The legacy "Piece" is read as the base forever, so old lines still resolve.
- **SA-738 time zone.**
  - One resolver and one fallback.
  - Every bypassing call site is migrated to the resolver.
  - A structural spec blocks new direct reads.
  - A census runs before any backfill.
- **SA-740 refund tender.**
  - A display-only interim with stated safety conditions.
  - The column lands in the next sitting, with a dual-write.
  - The backfill runs as a dry-run first.
  - The fallback is dropped once the census reads zero nulls.
- **SA-741 sitting bundle.**
  - A schema-only PR, with one folder per change.
  - Gated folders, with indexes last.
  - The readers follow after the bundle is applied and merged.
- **The fulfilment capability** (`packages/types/api/fulfilment.ts`). Free config modes resolve to one
  derived answer that every client and server rule reads. `unset` means today's behaviour.

## Worked variation maps

These calibrate the gate's questions. They are not rulings; the SA's retro audit of the approved POS
specs decides each one. On origin/master (checked 2026-10-08) there is no location, branch, warehouse or
till model.

**SA-750 end-of-day close.** The model is single-till, with a unique key on (tenantId, windowStart).
- Retail POS counter: BUILD NOW.
- Mixed: office and till payments land on one invoice, so the expected-cash figure counts only till
  tenders. BUILD NOW.
- Small team: who closed the day, and the reopen role. BUILD NOW.
- Delivery/route: drivers also collect cash, and "expected against counted over a window" is the same
  shape. LATER. The SEAM NOW is to keep the window and expected-cash logic a function of scope and
  window, not of "counter".
- Multi-branch: the POS trial prospect runs several branches. SEAM NOW: a NOT NULL till key with a
  default (for example `'main'`) in the unique key. Postgres treats NULLs as distinct in a unique index,
  so a nullable key would not hold. With the seam, a second till is S; without it, the change is an L
  (a new key on a live table, plus a backfill).

**SA-748 park and resume.** Parked carts live on one browser, keyed by tenant and user, and are cleared
at logout.
- Small team on a shared till: the staff PIN switch on the Later list changes the user, which would hide
  one cashier's parked sales from the next. This is a G3 conflict: decide which key the PIN switch uses
  before shipping.
- Multi-terminal: parked sales do not move between devices. This needs an owner-approved expiry (LATER),
  or a SEAM NOW: a server-ready park record (id, label, lines, customer, parkedAt, parkedBy), so that
  moving it to a table later is S.
- The refresh-safe cart in §1 is per-device UI state, and the device is the right place for it.

**SA-747 quick keys.** The ranking counts counter sales only, and the pins live under a counter-named
settings key.
- Delivery and wholesale: the order screen, and perhaps the buyer portal's order-again, could want the
  same "top sellers in this context". SEAM NOW: rank by a surface parameter, and namespace the setting
  by surface. Adding the order screen later is then S.
- Multi-branch: pins per location. LATER, since there is no location model.
- High volume: one grouped query over 30 days. Check that an index on the window columns exists.
- Settings home: this is tenant config data, so it goes to `systemConfig` under `SETTINGS_REGISTRY`,
  with a registry row and a screen.
