# Design Gate templates

Paste **one** block (Full, Lite or Hotfix) into the spec, fill every angle-bracket placeholder, and then
run `node .claude/skills/future-proof/scripts/check-gate.mjs <spec.md>` before asking for review. Pass
`-` instead of a file to read stdin, for example a PR body. The checker proves the block is complete;
the reviewer judges whether it is right ([REVIEWER-CHECKLIST](REVIEWER-CHECKLIST.md)).

## Filling rules

- **One line per answer.** Give each fact as path:line at the base sha in the heading, or as a live
  command plus its output.
- **No blanks.** An "n/a" always carries its reason, and no heading stays blank. "None" counts as an
  answer only after the query that found nothing.
- **Structure.** Keep the block at `##`, with `###` sub-headings.
- **Code in backticks.** Put types, generics and commands in backticks. The checker reads a bare
  angle-bracket phrase as an unfilled placeholder.
- **Marks:**
  - BUILD NOW: in this change.
  - SEAM NOW: shaped now so that the later change is small. Name the seam.
  - LATER: a note only.
  - n/a: give the reason.
- **Sizes:**

  | Size | Means |
  | --- | --- |
  | XS | a registry or config row |
  | S | about 100 lines or fewer, one area, no migration |
  | M | a migration, or two areas |
  | L | rework of a shipped model |

  Aim for S or smaller on every future line. An L means a seam is missing.

## Prompts for each axis

These are the typical differences between axes. Confirm with the owner whenever one of them decides the design.

| Axis | What usually differs there | In code today (origin/master, 2026-10-08) |
| --- | --- | --- |
| Wholesaler / distributor | account customers on credit terms, price tiers, boxes and pieces, invoices and statements, regulated or excise lines, delivery or shipping | profiles `delivery_distributor`, `shipping_wholesaler` |
| Jobber | a smaller reseller that buys from wholesalers: cash-and-carry pickups, van sales, thin margins, a small team | no profile key yet; a new type would be a registry row |
| Retail POS counter | walk-ins, tenders and change, receipts, returns at the till, drawer cash, quick keys | profile `in_store_retailer`; `capabilities.fulfilment.counter` |
| Delivery / route | drivers, stops, proof of delivery, cash collected on the road, offline phones | fleet modules `recurring_routes`, `order_delivery` |
| Mixed | the same customer on account and at the counter; office and till payments on one invoice | profile `in_store_shipping_retailer`; fulfilment `both`, `pickup_ship` |
| Super admin | creating, profiling, granting, comping and billing the tenant; seeing and setting the feature per tenant; protected tenants | platform-admin |
| Single store / 1 user | zero-config defaults, no role ceremony | — |
| Small team | roles (operators are close to admins, except for account admin), attribution, concurrent edits | the role in the JWT |
| Multi-branch / multi-warehouse | stock, tills, staff, settings and reports per location | no location, branch, warehouse or till model exists |
| High volume | thousands of SKUs or orders a day, many drivers or terminals | pagination, indexes, batch endpoints, `@LeaderCron` jobs |

## Area-sweep queries

Run these, then paste the exact commands into the block. The examples use the counter area; substitute
your area's paths and words.

- **Bug registry:** `grep '"register":"open"' .claude/campaign/bugs.jsonl | grep -iE 'counter-sale|counter'`.
  Records carry `location`, but `bugs.mjs list` has no file filter. Re-verify each hit on master,
  because registry states go stale.
- **Tracker issues:** `gh issue list --state open --limit 200 --search "counter sale"`, plus the KEEP
  rows by path in the newest `local-assets/handoff/*/issue-triage-bugs.md`.
- **ACTION-ITEMS:** `grep -n -iE 'counter|POS' .claude/handoffs/ACTION-ITEMS.md`.
- **Review nits and follow-ups:** `grep -il 'counter' local-assets/specs/*-review-*.md local-assets/specs/*-check-*.md`,
  plus the verdict board.

## Full

<!-- gate:full -->
```markdown
## Design Gate (Full) — <spec id> · <YYYY-MM-DD> · base <sha>

### G1 Fit
- Program / train: <the WORK-PLAN id and name, or none and why>
- Exists today: <the models, helpers, registries and screens this extends, as path:line>
- Decision: <extend which one, or new and why; the one source of truth it reads and writes>
- Facts: <each load-bearing fact as path:line or a live command with its output; every writer of each field it reads>

### Area sweep
| Source | Query run | Open ids in this area | Fixed here (own commit + red test) | Deferred (row + reason) |
| --- | --- | --- | --- | --- |
| Bug registry | <exact query> | <ids> | <ids> | <ids, rows and reasons> |
| Tracker issues | <exact query> | <ids> | <ids> | <ids, rows and reasons> |
| ACTION-ITEMS | <exact query> | <rows> | <rows> | <rows and reasons> |
| Review nits | <exact query> | <items> | <items> | <items, rows and reasons> |
- Chunk: <one area; how many issues; about how many changed lines; split by sub-area or not>

### G2 Variation map
| Axis | How it differs there (one line) | Mark | Seam in this change (SEAM NOW only) |
| --- | --- | --- | --- |
| Wholesaler / distributor | <difference> | <mark> | <seam or a dash> |
| Jobber | <difference> | <mark> | <seam or a dash> |
| Retail POS counter | <difference> | <mark> | <seam or a dash> |
| Delivery / route | <difference> | <mark> | <seam or a dash> |
| Mixed | <difference> | <mark> | <seam or a dash> |
| Super admin | <difference> | <mark> | <seam or a dash> |
| Single store / 1 user | <difference> | <mark> | <seam or a dash> |
| Small team | <difference> | <mark> | <seam or a dash> |
| Multi-branch / multi-warehouse | <difference> | <mark> | <seam or a dash> |
| High volume | <difference> | <mark> | <seam or a dash> |
- Surfaces & roles: <web operator, mobile (mirrors web), buyer portal, driver, super admin: which ones, and how>
- Capability read: <the derived answer, setting or registry each rule reads, never a profile key, slug or raw mode>
- Dark launch: <gate key, default, who flips it, when the flag is removed, or n/a and why>

### G3 Replace-later
| Planned program touching this area | Would it replace or rework this? | Answer |
| --- | --- | --- |
| <program and plan row> | <how> | <final shape now, a seam, or no conflict> |
- Interim: <none, or what it is, its owner-approved expiry, its follow-up row, and what keeps it safe meanwhile>

### G4 Class, not instance
- Class: <the class, in one line>
- Inventory: <the code predicate that defines it, and the count found at the base sha>
- One helper: <the name and file every site goes through>
- Pin: <the structural spec or required parameter that fails on a new bypass; no fail-open default>
- Red-first: <for each row, the case, master's value observed today, and the value after; guards labelled as guards>

### G5 Data & time
- Schema: <none, or the additive change and its sitting-bundle folder, with SEAM NOW columns in the same folder>
- Snapshot vs live: <what is frozen on the record, and what is read live>
- Authority & time: <what the server recomputes or builds; values decided early and where they are re-read; event order, retries, multi-device use, offline>
- Old shape → new: <in-flight attempts, rows issued ahead, legacy data; the census; dual-read until when; the dark-to-enforced flip>
- Money: <the pricing package helpers used, or n/a and why>

### G6 Scale
- Queries: <pagination or batching, the index used, and no per-row queries>
- Limits: <each cap, its value, and its one named constant or setting>
- UI at 10 and 10,000: <search, pagination or virtualisation, and no fetch-all picker>

### G7 UX lens
- Flow: <the apple-ux reading of the planned flow: one primary action per state, undo, and what is left out; or n/a for non-UI work>
- Feature parity: <the inventory of the changed screen; nothing lost or hidden; anything moved keeps a link>
- Placement sign-off: <apple-ux agrees because ...; apple-design agrees because ...>

### G8 Change-friendliness
- Config over code: <the setting home from the settings registry, a feature-registry mode, a profile row or an addon gate; or none needed and why>
- Shared contract: <the DTOs, enums and error codes in the shared types package, and their parity spec>
- Flags: <each flag and its removal date or trigger, or none>
- Code map: <the entry that will name the new seam>
- Future requirement → expected diff size:
  - <future requirement> → <size> (<what would change>)

### G9 Cost & stop
- Quick fix: <why this shape beats the quick fix, or why the quick fix is right here and its dated follow-up>
- YAGNI: <the seams considered and cut, and why>
- Review-round signal: <n/a, or the folds that opened new findings and the model that was re-picked>

### G10 Owner questions
- <none, or each question with its recommended option first, all asked in one box at planning>
```
<!-- /gate:full -->

## Lite

Use Lite for small work, one-area fixes, bug-pipeline `cause-ruling.md`, and folds that change a design.
Every heading stays, with one line each.

<!-- gate:lite -->
```markdown
## Design Gate (Lite) — <spec or bug id> · <YYYY-MM-DD> · base <sha>
- G1 Fit: <program; what this extends, as path:line; facts read at the base sha>
- Area sweep: <the queries run; the ids fixed here; the ids deferred, with rows>
- G2 Variation: <the types and tiers it differs for; SEAM NOW seams or none; LATER notes>
- G3 Replace-later: <each planned program touching it, and its answer: no conflict, a seam, or the final shape now>
- G4 Class: <one helper and its pin, or why it is a single site>; red: <master's value today, and the value after>
- G5 Data & time: <schema none or its sitting folder; snapshot; authority; old shape>
- G6 Scale: <pagination, index and caps, or n/a and why>
- G7 UX: <parity and placement sign-off, or n/a for non-UI work>
- G8 Change: <the config, registry or shared type that carries it>; future: <requirement> → <size>
- G9 Cost: <why this shape; the hotfix follow-up row, if any>
- G10 Owner questions: <none, or the batched box with a recommendation for each>
```
<!-- /gate:lite -->

## Hotfix

Use Hotfix only for a P0 security or money fix that ships now. The follow-up gets its own Full or Lite gate.

<!-- gate:hotfix -->
```markdown
## Design Gate (Hotfix) — <id> · <YYYY-MM-DD>
- Live harm stopped: <what this hotfix stops, in one line>
- Final shape + dated follow-up: <the final shape and its ACTION-ITEMS row, owner-approved>, due <YYYY-MM-DD>
- Area sweep filed as: <the ACTION-ITEMS row that holds this area's sweep>
```
<!-- /gate:hotfix -->
