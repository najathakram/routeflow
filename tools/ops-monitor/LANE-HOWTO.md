# Ops monitor: lane how-to (paste into every lane prompt)

```
OPS MONITOR (D-2026-10-19): the live board is the source of truth for work. Derived facts (PRs, CI,
merges, deploys, bugs) are read automatically; you record only human facts, once, with `rf`:
  rf = node tools/ops-monitor/bin/rf.mjs   (from any routeflow checkout that has tools/ops-monitor)
ONCE per checkout, at its root: `rf whoami --lane <lead|sa|pc-lane|macmini|macbook|coordinator|ops-monitor>`
(on a new machine also `rf whoami --machine <pc|macmini|macbook>`). Your session then starts with a
monitor brief, and the lead gets a "since you last looked" line on each prompt.
- Take work:      rf next            then  rf claim <id> --branch <branch>   (one owner per card)
- Status change:  rf status <id> <spec|building|review|ready|shipping|live|verified|parked|dropped>
- Blocked:        rf block <id> --by "<what>" --unblocker <lane>   ·   rf unblock <id>
- Link work:      rf event link <id> --branch <b> --pr <n>   (a branch named fix/b1234-… or feat/544-…
                  links itself; a PR TITLE naming B1234 / "row 544" links itself; body text only
                  with "Fixes/Closes B1234" or "Closes row 544")
- New work:       rf item new --title "<user-terms title>" --type bug|feature|spec|chore|ops|decision
                  --problem "<what is wrong, as a customer says it>" --impact "<who it hurts, what it
                  costs>" [--solution "<how we fix it>"] [--priority P1] [--train R3] [--parent <id>]
                  [--eta 10-21]       (problem + impact are REQUIRED for P0/P1 bug/feature/incident)
                  New items get ids W-1, W-2, ...; plain numbers belong to the register.
- Plain words:    write problem/impact/solution for the OWNER (business terms, no codes). Editing
                  them on a drafted item confirms the draft.
- Rulings / owner answers / notes: rf event ruling --ref SA-816 --summary "…" [<id>] ·
  rf event owner-decision --question "…" --answer "…" [<id>] · rf event note --text "…" [<id>]
- Bugs: only lead/coordinator file them: rf bug file "<title>" --location … --severity … (wraps bugs.mjs)
- Done:           rf status <id> shipping after the merge, live after the deploy (claims release)
- Brief any time: rf brief            ·   your cards: rf ls --lane <you>   ·   counts: rf audit
Pushes and PRs record themselves (post-push hook). The Stop hook refuses to end a turn after a
push/PR/merge with no matching event or item link, or after you changed a plan file in
routeflow-specs (decisions/releases/priorities/briefs/register/roadmap/specs/DASHBOARD) or (lead)
assigned work by message without recording it; it prints the exact `rf` command. It fails open on
its own errors and after 3 identical blocks; RF_OPS_GATE=off disables it. Never hand-edit
register/WORK-REGISTER.md once the lead switches it to generated. No security details in events.
```
