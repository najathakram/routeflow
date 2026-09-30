# Discovery — sign-in pages in the redesign look (auth-redesign)

Slug `2026-09-07-auth-redesign` · branch `feat/auth-redesign` (stacks on `feat/marketing-port`, PR #657) ·
worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09` · owner request 2026-09-07.

## The problem, in the requester's words

"Sign in pages were not updated. … I want sign in pages to have the new version too!" — the owner,
reviewing the ported marketing site. The marketing port (PR #657) deliberately scoped the auth screens to a
logo swap (its spec's non-goal: "the auth screens' redesign (only their logo changes)"). So the first click
from the new marketing site — "Distributor sign in", "Retailer sign in", "Start your free trial" — lands on a
page in the previous visual language (cream/teal gradient, Instrument Serif, Ledger cards). It reads as a
seam between two products.

## Whose problem, how often, what it costs

- **Prospects** (signup, buyer register) — every new account starts here; the seam lands exactly at the
  moment of highest intent.
- **Distributors and retailers** (login, buyer login) — every session on a desktop starts here (phones get
  the mobile-web build's own login via the middleware proxy; unchanged).
- **Anyone recovering a password** (forgot/reset, both portals) and the post-signup utility pages
  (check-email, verify-email, verify-merge, change-password, invite).
- Cost: credibility of the redesign; the owner will not GO on the marketing site while the sign-in pages
  contradict it. There is no workaround.

## Why now

The marketing port is in review; landing the auth look right behind it makes the redesign whole for every
signed-out surface a visitor can reach.

## What happens if we ship nothing

The marketing site ships with the seam; every sign-in remains a visual regression relative to the page
before it. The owner has said explicitly they want it.

## Success signal

Every auth page renders inside the redesign's two-panel shell (navy story panel + white form panel) with
its existing form, copy, labels, links and behaviour unchanged. Evidence: the existing auth Jest suites and
Playwright AP-01..AP-09 stay green with zero edits; a new Playwright spec 46 (`auth-redesign`) shows the
shell on six public routes at desktop and the collapsed band at 375 px; the deployment E2E after merge shows
spec 07 + spec 36 + spec 46 green. Baseline today: 0 of 13 pages use the shell.

## Is this a symptom?

No. The design exists (the redesign source's `AuthPreview`); the pages were simply out of scope for #657.

## Are we building the solution someone already picked?

Yes, and that is correct here: the owner chose the redesign's look. What the redesign source does NOT have
is working auth pages — its six auth routes are read-only mockups ("Design preview… No credentials, accounts,
or reset emails are sent") with fake values that link out to the live site. So the work is a **reskin of the
13 real, working pages into that look**, never a port of the mockups' behaviour.

## Strongest objection and the answer

"Thirteen files on the auth path for a look change is a wide blast radius." — The logic does not move:
every page keeps its schema, handler, states, labels, placeholders, link targets and security behaviour
(enumeration-safe copy, token scrub, redirect validation, throttle countdown). Only the outer wrapper and
scoped CSS change, through ONE shared `AuthShell` component, and the existing tests are the regression fence
(they pin every label and link that matters). The engine treats these files as HIGH risk (auth) and reviews
accordingly.

## Prior work reused

`.claude/pipeline/2026-09-07-marketing-port/` (spec, ux-spec, design tokens, the brand components,
the `no-next-image` guard, the `globals.css` containment pin), `.claude/pipeline/design-system.md`,
`local-assets/handoff/2026-09-06/auth-redesign-brief.md` (the evidence brief this plan was written from),
lessons L-072 (no hand mirrors), L-087 (pin current state), L-089 (caps are rendering budgets).
