# Register citation re-anchor — Step 0 audit

Produced by the campaign-kickoff prep pass, `master@6c8f1401`, 2026-08-30. Mechanized re-check of
every `path:line` citation in `local-assets/docs/routeflow-bug-register.html` (187 entries, 179
open) against the current master worktree, per the plan's Step 0
(`read-the-bug-registry-scalable-gosling.md`).

## Method

A script (`extract-citations.mjs` + `verify-citations.mjs`, kept in this session's scratchpad, not
checked in) parsed each bug article's `<div class="evidence">` block into individual
`(file, startLine, endLine, comment)` citations, resolved the file against the worktree (direct
path, then last-full-directory + bare filename, then a repo-wide basename search), and — where the
comment carried a backtick-quoted code token or a strong identifier (camelCase/PascalCase/
snake_case/dotted/function-call-like) — grepped the resolved file for that token and compared the
hit line(s) to the cited range.

- **1176 individual citations** parsed across **182 of the 187 entries** (the other 5 are the
  Cleared/Fixed entries whose evidence uses a different format).
- **286 OK** — token found within the cited range, still accurate.
- **60 MOVED** — token found, but at a different line than cited.
  - **13 had exactly one candidate hit** → corrected directly in the register (see below).
  - **47 had multiple candidate hits** → left as `NEEDS_DISCOVERY_CHECK (multi-candidate)`
    below; the batch's own discovery step must disambiguate, but need not sweep the repo — the
    file is already known and correct, only the exact line within it is ambiguous.
- **11 TOKEN_NOT_FOUND**, **32 OUT_OF_BOUNDS** (cited line beyond the file's current length —
  unambiguous drift), **31 FILE_NOT_FOUND / AMBIGUOUS_FILE** (path resolution failed, mostly the
  register's own `.../` elision shorthand for a handful of web-page paths) — all left as
  `NEEDS_DISCOVERY_CHECK` below.
- **756 NO_TOKEN_UNVERIFIED** — the comment carried no distinguishing token (e.g. plain-English
  descriptions with no identifier), so the tool could neither confirm nor refute the citation.
  This is the normal case discovery already exists to handle; no special flag needed beyond
  business as usual.

**Known tool limitation, not a real drift — B03 only.** The evidence clause `apps/api/src/auth/dto/
reset-password.dto.ts:16, apps/api/src/buyer/dto/buyer-register.dto.ts:18, apps/api/src/buyer/dto/
buyer-change-password.dto.ts:22 (all …)` cites three files in one comma-joined clause with a single
trailing comment; the parser attributed all three line numbers to the first file, which produced a
spurious "moved" reading. Manually confirmed: all three lines are correct as cited (line 16 in
`reset-password.dto.ts` does contain the cited regex token). **No correction applied; B03's
citations are fine.** Left out of the per-batch table below.

## The 13 applied corrections

Scoped, in-place edits inside each bug's own `<article>` block only (verified no collateral edits —
`<article>`/`</article>` counts unchanged at 210/210 before and after). Each rewritten citation
reads `<file>:~<newLine> [re-anchored master@6c8f1401; was <oldRange> at hunt round
master@<roundSha>]` — the `~` signals "verified anchor point via a matched token", not a
re-derived exact end-of-range (the original hunt-round tree for `e5b0af8e`/`0cd59277` is not an
ancestor of master, so there is no git history to walk for those; for the three ancestor SHAs
(`0b2c3a0a`, `2d0270fd`, `28cb0a25`) the same token-match anchor was used for consistency rather
than mixing methods).

| Bug ID | File                          | Was        | Now (verified) | Hunt round      |
| ------ | ----------------------------- | ---------- | -------------- | --------------- |
| B54    | routes.service.ts             | :2090-2103 | ~L2271         | master@e5b0af8e |
| B66    | invoices.service.ts           | :4779-4783 | ~L4755         | master@e5b0af8e |
| B71    | routes.service.ts             | :2057-2072 | ~L2236         | master@e5b0af8e |
| B72    | routes.service.ts             | :2075-2081 | ~L2236         | master@e5b0af8e |
| B84    | invoices.service.ts           | :3970      | ~L3968         | master@e5b0af8e |
| B126   | settings.controller.ts        | :186-189   | ~L185          | master@0b2c3a0a |
| B74    | invoices.service.ts           | :3635-3636 | ~L3626         | master@e5b0af8e |
| B158   | customers.service.ts          | :108-113   | ~L103          | master@0b2c3a0a |
| B176   | routes.service.ts             | :1429-1431 | ~L1405         | master@0b2c3a0a |
| B177   | route-optimization.service.ts | :1059-1070 | ~L1078         | master@0b2c3a0a |
| B88    | create-purchase-order.dto.ts  | :49        | ~L36           | master@e5b0af8e |
| B29    | routes.ts (web)               | :658-684   | ~L707          | master@2d0270fd |
| B186   | routes.service.ts             | :965-969   | ~L787          | master@0b2c3a0a |

B54 matches the plan's own worked example exactly (`:2090-2103` → `:2271`, "181 lines off"),
confirming the method.

## Round-SHA ancestry (for traceability, per the plan)

| Round SHA                | Ancestor of master `6c8f1401`? | Bug articles anchored to it |
| ------------------------ | ------------------------------ | --------------------------- |
| `0b2c3a0a`               | yes                            | 62                          |
| `e5b0af8e`               | **no**                         | 50                          |
| `2d0270fd`               | yes                            | 44                          |
| `0cd59277`               | **no**                         | 27                          |
| `28cb0a25`               | yes                            | 3                           |
| (none — Cleared entries) | —                              | 1                           |

Each bug's canonical (most recent) verinote round SHA is recorded per-ID in
`.claude/campaign/status/F##.jsonl` as the `roundSha` field, so a stale citation stays traceable to
its hunt round rather than mysterious, per the plan's Step 0 instruction.

## Per-batch citation attention list

Every bug ID below has at least one citation this pass could not fully confirm. Entries not listed
(most of the 179) either verified clean or fell into the large "no distinguishing token" bucket —
normal discovery applies with no special flag. **None of this blocks starting the campaign** — it
is exactly the input the plan expects discovery to consume ("confirm these lines still say what
the register says … within the files the card names", never a repo sweep).

### F00/F01/cleared

| Bug ID | Severity | Status | Action for discovery                                                                                                       |
| ------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| B40    | High     | MOVED  | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |

### F02

| Bug ID | Severity | Status         | Action for discovery                                                                                                   |
| ------ | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| B101   | High     | OUT_OF_BOUNDS  | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file  |
| B126   | Critical | MOVED          | citation corrected in register to a verified ~L anchor; confirm it still holds                                         |
| B154   | Medium   | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file |

### F03

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B57    | Critical | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B74    | High     | MOVED           | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B81    | Medium   | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B84    | Medium   | OUT_OF_BOUNDS   | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B85    | Medium   | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B102   | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B103   | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |

### F05

| Bug ID | Severity | Status         | Action for discovery                                                                                                       |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B49    | Critical | MOVED          | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B148   | High     | FILE_NOT_FOUND | citation could not be auto-verified (FILE_NOT_FOUND); confirm path:line before trusting it, stay within the cited file     |
| B152   | Medium   | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B167   | Medium   | OUT_OF_BOUNDS  | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |

### F06

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B51    | Critical | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B60    | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B62    | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B63    | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B78    | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |

### F07

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B56    | Critical | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B105   | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B116   | Medium   | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |

### F08

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B20    | High     | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B53    | Critical | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B75    | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B82    | Medium   | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B128   | Critical | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |

### F09

| Bug ID | Severity | Status          | Action for discovery                                                                                                    |
| ------ | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B18    | Low      | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file  |
| B19    | Medium   | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file  |
| B66    | High     | MOVED           | citation corrected in register to a verified ~L anchor; confirm it still holds                                          |
| B67    | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file |

### F10

| Bug ID | Severity | Status | Action for discovery                                                                                                       |
| ------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| B54    | Critical | MOVED  | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B55    | Critical | MOVED  | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B71    | High     | MOVED  | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B72    | High     | MOVED  | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |

### F11

| Bug ID | Severity | Status         | Action for discovery                                                                                                   |
| ------ | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| B146   | High     | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file |

### F12

| Bug ID | Severity | Status         | Action for discovery                                                                                                       |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B29    | Medium   | AMBIGUOUS_FILE | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B147   | High     | MOVED          | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B161   | Medium   | FILE_NOT_FOUND | citation could not be auto-verified (FILE_NOT_FOUND); confirm path:line before trusting it, stay within the cited file     |
| B177   | Low      | OUT_OF_BOUNDS  | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |

### F13

| Bug ID | Severity | Status        | Action for discovery                                                                                                  |
| ------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| B09    | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |
| B46    | Critical | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |
| B48    | Critical | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |
| B92    | Medium   | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |

### F14

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B132   | High     | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B133   | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B138   | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |
| B165   | Medium   | OUT_OF_BOUNDS   | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |

### F15

| Bug ID | Severity | Status          | Action for discovery                                                                                                       |
| ------ | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B131   | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B141   | High     | MOVED           | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B156   | Medium   | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B158   | Medium   | MOVED           | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |
| B170   | Medium   | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file    |

### F16

| Bug ID | Severity | Status        | Action for discovery                                                                                                       |
| ------ | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B89    | Medium   | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |
| B100   | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |
| B117   | Medium   | MOVED         | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B144   | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |

### F18

| Bug ID | Severity | Status        | Action for discovery                                                                                                  |
| ------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| B73    | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |

### F19

| Bug ID | Severity | Status        | Action for discovery                                                                                                  |
| ------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| B137   | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |
| B140   | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |
| B143   | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file |

### F20

| Bug ID | Severity | Status         | Action for discovery                                                                                                       |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B04    | High     | MOVED          | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B95    | Low      | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B151   | High     | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |

### F21

| Bug ID | Severity | Status          | Action for discovery                                                                                                    |
| ------ | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B104   | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file |
| B139   | High     | AMBIGUOUS_FILE  | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file  |

### F22

| Bug ID | Severity | Status | Action for discovery                                                           |
| ------ | -------- | ------ | ------------------------------------------------------------------------------ |
| B186   | Low      | MOVED  | citation corrected in register to a verified ~L anchor; confirm it still holds |

### F23

| Bug ID | Severity | Status         | Action for discovery                                                                                                   |
| ------ | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| B145   | High     | FILE_NOT_FOUND | citation could not be auto-verified (FILE_NOT_FOUND); confirm path:line before trusting it, stay within the cited file |
| B180   | Low      | OUT_OF_BOUNDS  | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file  |

### F24

| Bug ID | Severity | Status | Action for discovery                                                                                                       |
| ------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| B134   | High     | MOVED  | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |

### F25

| Bug ID | Severity | Status         | Action for discovery                                                                                                       |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B91    | Medium   | AMBIGUOUS_FILE | citation could not be auto-verified (AMBIGUOUS_FILE); confirm path:line before trusting it, stay within the cited file     |
| B118   | Medium   | MOVED          | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |

### F26

| Bug ID | Severity | Status          | Action for discovery                                                                                                    |
| ------ | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B14    | Medium   | OUT_OF_BOUNDS   | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file   |
| B25    | High     | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file |
| B27    | Medium   | OUT_OF_BOUNDS   | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file   |
| B28    | Low      | TOKEN_NOT_FOUND | citation could not be auto-verified (TOKEN_NOT_FOUND); confirm path:line before trusting it, stay within the cited file |
| B88    | Medium   | MOVED           | citation corrected in register to a verified ~L anchor; confirm it still holds                                          |

### F27

| Bug ID | Severity | Status        | Action for discovery                                                                                                       |
| ------ | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B17    | High     | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |
| B79    | High     | MOVED         | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |

### F28

| Bug ID | Severity | Status | Action for discovery                                                                                                       |
| ------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| B153   | Medium   | MOVED  | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B176   | Low      | MOVED  | citation corrected in register to a verified ~L anchor; confirm it still holds                                             |

### F29

| Bug ID | Severity | Status        | Action for discovery                                                                                                       |
| ------ | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B03    | Medium   | MOVED         | multiple candidate lines matched the cited token; disambiguate manually, no repo sweep needed (stay within the cited file) |
| B36    | Medium   | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |
| B173   | Low      | OUT_OF_BOUNDS | citation could not be auto-verified (OUT_OF_BOUNDS); confirm path:line before trusting it, stay within the cited file      |
