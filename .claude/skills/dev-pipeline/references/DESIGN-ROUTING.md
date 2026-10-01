# Design routing

> Reference for **S3 — UX & design system** (UI work only). Loaded on demand — not
> pasted into every agent prompt. Pairs with
> [templates/UX-SPEC.md](../templates/UX-SPEC.md), which every UI screen must fill in
> after this procedure runs.

## Derive before you design

For an existing product, the design system already exists in the code even when no one
wrote it down. Extract it before designing anything new — a new screen that doesn't cite
the derived system is inventing its own, silently, screen by screen, until nothing
matches. Only when extraction turns up genuinely nothing do you *design* a system, and
even then the result is written down before any component is built.

### Concrete extraction steps

Run these against the target repo (not the pipeline repo) before touching `ux-spec.md`:

1. **Theme / Tailwind config** — locate `tailwind.config.*`, a theme provider, or a
   CSS-in-JS theme object. Pull the color scale, spacing scale, type scale, radius
   scale, shadow scale, and breakpoints as they're actually defined — not as you'd
   guess them.
2. **CSS custom properties** — grep the global stylesheet(s) for `:root { --... }` (and
   any `[data-theme]`/dark-mode overrides). List each variable name and its resolved
   value in both themes if the repo has more than one.
3. **Component library directory** — find the shared UI component directory (e.g. a
   `packages/ui`-style workspace, or `components/ui/`). For **every** component, list
   its variants and props, not just that it exists: `Button: variant=primary|secondary|
   ghost|destructive, size=sm|md|lg, disabled, loading`. A component inventory without
   variants is useless for reuse decisions.
4. **Spacing / type / radius / shadow scales** — restate step 1's tokens as one
   numbered scale each (e.g. `space-1 = 4px, space-2 = 8px, ...`). This is what the
   compliance table in `ux-spec.md` cites.
5. **Icon set** — name the actual icon library/pack imported in the repo (don't guess
   from convention), and how icons are sized and colored (prop, class, or CSS var).
6. **Motion durations & easings** — grep for transition/animation config: CSS
   `transition`/`@keyframes`, a motion library's variant objects, or utility-class
   durations. List the real values in use, not framework defaults that aren't invoked.
7. **Existing empty / loading / error patterns** — find at least one shipped example of
   each state (a skeleton component, an empty-state component, a toast/error-boundary
   pattern) and cite the file. If a pattern genuinely doesn't exist yet, say so — that's
   a gap `ux-spec.md` must fill deliberately, not by improvising per screen.
8. **A11y baseline** — check for an a11y lint config (e.g. a jsx-a11y-style plugin), any
   documented contrast or target-size standard, and existing `:focus-visible` styles.
   If none exists, the baseline defaults to WCAG 2.2 AA — say that explicitly rather
   than leaving the baseline unstated.

### What to write into `.claude/pipeline/design-system.md`

One cached file, repo-level (not per-task), with these sections:

- **Tokens** — color / spacing / type / radius / shadow / breakpoints, each with its
  value and source file.
- **Components** — name, variants, props, source file, one row per component.
- **Icons** — library name + the sizing/coloring convention in use.
- **Motion** — durations and easings actually in use, as a table.
- **State patterns** — empty / loading / error: component name + source file for each,
  or "none found — needs designing" if a gap exists.
- **A11y baseline** — contrast rule, target-size rule, focus style, in force for this
  repo.

Every entry cites its source file. A token or component listed with no citation was not
derived — it was invented, and invented entries are exactly what this procedure exists
to prevent.

### When to refresh it

- **No cache exists yet** — run the full extraction before any UI work in S3.
- **Cache exists** — check it against the current repo state before trusting it: a
  design-system file that predates recent UI changes (new components added, tokens
  renamed) is stale. When in doubt, re-run the steps that touch the area this task's
  screens live in rather than trusting a possibly-stale full file.
- **Genuinely nothing found** (greenfield surface, or a repo extraction turns up no
  reusable system at all) — design the system fresh using the routes below, then write
  the result into `design-system.md` **before** any component gets built against it.
  A system decided implicitly while building screen 1 is not written down and will
  drift by screen 2.

## Route by need

Use the exact installed skill/agent names below — never invent a skill name that isn't
in this table.

| Need | Route |
|---|---|
| Problem framing, research synthesis, opportunity sizing, scoping | `intent:strategize`, `intent:investigate` (agent `intent:ember`) |
| Entry point / unsure which design skill / ethics and dark-pattern check | `intent:intent` (agent `intent:noor`) |
| End-to-end flows, journeys, information architecture | `intent:journey`, `intent:organize` (agent `intent:wren`) |
| Screen structure before visuals; lo-fi to click-through | `intent:wireframe` |
| UI copy, error messages, empty states, voice | `intent:articulate` |
| Engineering handoff spec, variant matrices, test plan for the design | `intent:specify` (agent `intent:rune`) |
| Heuristic / accessibility / resilience audit of an existing design | `intent:evaluate`, `intent:include`, `intent:fortify` (agent `intent:vigil`) |
| Stuck, or the framing feels wrong | `intent:philosopher` (agent `intent:sage`) |
| Visual craft: polish, hierarchy, boldness, motion, "make it feel designed" | `impeccable:impeccable` |
| Design tokens, palettes, font pairings, style/product-type lookup, charts | `ui-ux-pro-max:ui-ux-pro-max`, `ui-ux-pro-max:design-system`, `ui-ux-pro-max:ui-styling` |
| Brand identity, logo, banners, slides | `ui-ux-pro-max:brand`, `ui-ux-pro-max:design` |
| Multi-artboard visual mockup the owner can tweak by hand | `design` (Claude Design canvas artifact) |
| Charts and dashboards | `dataviz` |
| Motion audit / adding or fixing animation | `find-animation-opportunities`, `improve-animations`, `apple-design`, `emil-design-eng` |

## Standing rules

- **Never invent a token that exists.** If `design-system.md` already has a color,
  spacing value, radius, shadow, or breakpoint that fits, cite it — don't compute a
  new one that happens to look similar.
- **A new component earns its existence.** Propose one only when no existing component
  can be composed to do the job. Record what was checked and found insufficient in
  `ux-spec.md`'s compliance table — a new component with no justification row is a
  rejected design.
- **Ship the full state set.** Every new surface carries all of default / empty /
  loading / partial / error / unauthorized / offline / too-much-data / stale /
  concurrent-edit / success-confirmation — see the state-set table in
  [templates/UX-SPEC.md](../templates/UX-SPEC.md). A screen missing a state is
  incomplete, not "polish for later".
- **Accessibility is a spec requirement, not a review nit.** It's written into
  `ux-spec.md`'s Accessibility section before implementation starts — the
  `design-system` review lens checks compliance against what was specified, it doesn't
  discover the requirement for the first time.
- **Verify the visual result with a Playwright screenshot, not from source.** Reading
  the component code cannot confirm what actually renders — spacing, contrast,
  responsive reflow, and motion are only real once rendered. UI-verify drives the page
  and screenshots it; see [TESTING-PLAYBOOK.md](TESTING-PLAYBOOK.md) for the Playwright
  house rules that govern how.
