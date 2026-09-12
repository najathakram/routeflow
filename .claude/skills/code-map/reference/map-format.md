# Code Map — file format

Exact skeletons for the files under `.claude/code-map/`. Keep every entry terse: a map is an
**index to navigate by**, not documentation. If an entry is longer than the code is to skim,
it is too long.

## Hard caps

| File                                                                  | Cap                                               |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `INDEX.md`                                                            | ≤ 20,000 bytes total; no table row over 200 bytes |
| `CHANGELOG.md`                                                        | ≤ 40,000 bytes, ≤ 30 dated entries                |
| `<area>.md` entry                                                     | ~200–300 bytes each — signatures, never bodies    |
| `<area>.md` (or any split-out `<area>/<module>.md` part) — total file | ≤ 100,000 bytes                                   |

A row over 200 bytes is prose that belongs in the owning area file, not the table cell — see
the "Where to find" convention below. An area file over the 100,000-byte total cap is prose
that belongs in more than one file — see "Splitting a large area file" below. A project can
enforce these mechanically with [`reference/validate-code-map.mjs`](validate-code-map.mjs)
(copy into `scripts/`, wire into `npm run verify`); it fails the build on any cap violation
(printing every area/part file's byte size) and warns (non-blocking) on a stale `mappedSha`.

---

## `INDEX.md`

```markdown
# Code Map — <project name>

> Signature-level index of this repo. Read this first; open only the files it points to.
> Last reconciled: see `_meta.json.mappedSha`. Maintained by the `code-map` skill.

## Stack & shape

- <language/framework per app>, <db>, <deploy target>. <monorepo tool> if applicable.
- Workspaces / top-level areas: <list, each linking its area file>.

## Entry points

- <app> → `<path/to/main>` — <what boots, port, prefix>.
- <app> → `<path>` — <...>.

## Build / test / run

| Action | Command |
| ------ | ------- |
| dev    | `...`   |
| build  | `...`   |
| test   | `...`   |
| lint   | `...`   |

## Where to find (global)

| topic                   | Start at                            |
| ----------------------- | ----------------------------------- |
| <feature or symptom>    | `<area>.md#<anchor>` — <one clause> |
| <cross-cutting concern> | `path/...`                          |

Each row is a pointer, not a summary: `| topic | <area>.md#anchor — one clause |`. The actual
prose — why, how, gotchas — lives in the area file under that anchored heading (`### <topic>`),
never inlined in the cell. This is what keeps INDEX.md rows under the 200-byte cap regardless
of how much there is to say about the topic.

## Areas

- [`<area>`](<area>.md) — <one-line scope>.
```

---

## `<area>.md` (one per workspace / app / major module)

```markdown
# Area: <name> (`<root path>`)

<One line: what this area is and its role.>

## Where to find (this area)

| Need   | File → symbol                  |
| ------ | ------------------------------ |
| <task> | `path/file.ts` → `funcOrClass` |

## Modules / files

### `<sub-module or dir>/`

- **`file.ts`** — <one-line purpose>.
  - exports: `fnName(args): Ret`, `ClassName`, `type Foo`, `default <Component>`.
  - deps: `../other-module`, `@scope/pkg`.
  - callers: `path/a.ts`, `path/b.ts` — direct 1-hop importers of this file's exports, or `—`.
  - callees: `path/c.ts` → `helperFn` — the direct 1-hop calls this file makes out, or `—`.
  - side effects: <DB models touched / network / events / filesystem>, or `—`.

### `<next sub-module>/`

...
```

Granularity rule: start at **module level** — enough to choose _which_ file to open. Deepen a
single file's entry (more exports, call-outs) only when a task actually needed that detail, so
the map grows where work happens and stays thin elsewhere.

### Splitting a large area file

An area larger than the ≤ 100,000-byte cap is split into `<area>/<module>.md` parts, with
`<area>.md` itself kept as a ≤ 8,000-byte table of contents whose rows point at each part's
anchor. `INDEX.md`'s where-to-find rows then point at the part file directly, never at
`<area>.md` (a reader following the pointer should land on the section, not on a table of
contents one hop away from it):

```markdown
# api.md (table of contents — split at 2026-09-10, see CHANGELOG.md)

| Module   | File              |
| -------- | ----------------- |
| billing  | `api/billing.md`  |
| auth     | `api/auth.md`     |
| webhooks | `api/webhooks.md` |
```

Consult pattern once a part file exists: **read the section, not the file.** Locate the anchor
with `Grep` first (the heading or symbol name from the where-to-find row), then `Read` with an
offset/limit of ~120 lines around the match — never `Read` a whole multi-hundred-KB part file
to reach one entry.

---

## `_meta.json`

```json
{
  "schemaVersion": 1,
  "mappedSha": "<git commit SHA the map was last reconciled against>",
  "generatedAt": "<ISO 8601 timestamp>",
  "areas": ["api", "web", "mobile", "packages"],
  "fileCount": 0
}
```

- **`mappedSha`** is load-bearing: `git diff --name-only <mappedSha> HEAD` is how a later
  session finds exactly what drifted. Update it when you reconcile the map to a commit.
- `fileCount` is a coarse drift signal (big swings → consider a re-map).
- Keep this file small; it churns on every update and that is fine. Session history goes in
  `CHANGELOG.md` below, never accumulated here as prose.

---

## `CHANGELOG.md` (recommended once a project is active)

```markdown
# Code Map Changelog

> Dated session notes, newest first. Hard cap: ≤ 40,000 bytes / ≤ 30 entries — trim older
> entries below to `git log -- .claude/code-map`.

- **2026-09-10** — <what changed and why, one line>.
- **2026-09-08** — <...>.
```

Each entry is a top-level dated bullet (`- **YYYY-MM-DD** — ...`), not a `## ` heading — that
exact prefix is what a validator counts entries by. When either cap is hit, delete the oldest
entries and leave a one-line pointer to `git log -- .claude/code-map` in their place.

---

## Conventions

- **Signatures, not bodies.** `createInvoice(dto, tenantId): Promise<Invoice>` — never the
  implementation.
- **Stable anchors.** Reference `path:symbol`. Paths are clickable; symbols survive line moves
  better than line numbers (use line numbers only for long-lived landmarks).
- **Cross-refs over duplication.** If two areas interact, note the edge once on each side
  (`→ used by web/lib/api-client.ts`) rather than re-describing the other area.
- **Callers/callees are 1-hop only, never transitive.** List the files that directly import this
  one, and the files this one directly calls out to — not the whole call graph. A reader wanting
  the second hop follows the pointer into that file's own entry. Where
  [`extract-signatures.mjs`](extract-signatures.mjs) ran, these come from it deterministically;
  the model still writes the one-line purpose by hand.
- **Terse English.** Fragments, not sentences. No marketing, no emojis.
- **Caps are enforced, not aspirational.** If a project wires in
  [`validate-code-map.mjs`](validate-code-map.mjs), a cap violation fails `npm run verify` —
  treat a failing validator the same as a failing test, not a style nit.
