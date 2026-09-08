# Landing record — auth-redesign (spec 46)

Engine stopped mid fix-loop (62 agents, no result.json) on checkpoint `102c79ce`;
closed out via a light loop instead of relaunching (never resumeFromRunId, never
a second engine on the implemented tree).

## Rounds

- **R1** — Opus refute-first review on `102c79ce`: verdict FIX-FIRST. C1-C9, C12
  HELD; C10 REFUTED; C11 partial.
- **R3** — Opus UI judge on the same checkpoint: verdict FIX-FIRST (F1-F11).
- **Round 2 (Fable ruling, fix-round-2.md)** — rules R1+R3 into D1-D10: state-derived
  titles (D1), fenced-heading periods removed (D2), drop dead specs 47/48 (D3), scope
  `auth-shell.css` under `.rf-auth` (D4), buyer link contrast to the operator palette
  (D5), 375px placeholder fit (D6), focus-ring hug (D7), ux-spec corrections (D8),
  read-only F3 re-probe (D9), new static pins (D10). Executed by E1 Opus / E2 Sonnet /
  E3 Sonnet.
- **Round 2b** — E4 driver re-verify (375 placeholders, focus shots, buyer link
  colour, `/change-password` seeded on the `test` tenant) + one scoped Opus re-check
  of D1-D8.
- **Opus SHIP verdict** closes the loop.

## Step-1 fixes (this session, Fable ruling)

1. `auth-redesign.static.test.ts` (~347-357): the "state string exactly once"
   pin only counted quoted literals, so a restored JSX heading (`>{state}<`)
   would not turn it red. Added a second assertion that the page source
   contains no `>` + state + `<` occurrence, alongside the existing check.
2. `apps/web/app/change-password/page.tsx` (~68): `title="Choose a new
password."` → `"Choose a new password"` (dropped the trailing period) to
   match both reset-password pages' fenced heading (D2).

## Deferred (registry rows, not fixed here)

- **F11** — operator/buyer copy asymmetries (OR/or, arrow glyph, footer link
  wording) — fenced, page-owned strings.
- **LOW-2** — login test module-mocks tenant-host + tenant-provider instead of
  exercising `tenantSlugFromHostname` directly; unit coverage stands in.
- **LOW-3** — story `h2` precedes the card `h1` in DOM order; design intent,
  hidden ≤ 850px.
- **F10** — disabled resend-code label at 3.27:1 contrast; WCAG-exempt
  (disabled control).

## Evidence (gitignored)

- `apps/web/test-output/auth-redesign/light-r1/`
- `apps/web/test-output/auth-redesign/light-r2/`
