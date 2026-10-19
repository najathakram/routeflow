# Ops monitor: lane how-to (paste into every lane prompt)

```
OPS MONITOR (D-2026-10-19): the live board is the source of truth for work. Derived facts (PRs, CI,
merges, deploys, bugs) are read automatically; you record only human facts, once, with `rf`:
  rf = node tools/ops-monitor/bin/rf.mjs   (from any routeflow checkout that has tools/ops-monitor)
  Set RF_LANE=<your lane id> once (lead | sa | pc-lane | macmini | macbook | ops-monitor) and, on a
  new machine, `rf whoami --machine <pc|macmini|macbook>`.
- Take work:      rf next            then  rf claim <id> --branch <branch>   (one owner per card)
- Status change:  rf status <id> <spec|building|review|ready|shipping|live|verified|parked|dropped>
- Blocked:        rf block <id> --by "<what>" --unblocker <lane>   ·   rf unblock <id>
- Link work:      rf event link <id> --branch <b> --pr <n>   (a branch named fix/b1234-… or feat/544-…
                  links itself)
- New work:       rf item new --title "<user-terms title>" --type bug|feature|spec|chore|ops|decision
                  [--priority P1] [--train R3] [--parent <id>] [--area domain:catalog] [--eta 10-21]
- Rulings / owner answers / notes: rf event ruling --ref SA-816 --summary "…" [<id>] ·
  rf event owner-decision --question "…" --answer "…" [<id>] · rf event note --text "…" [<id>]
- Done:           rf status <id> live   (after the merge; the claim releases itself)
Pushes and PRs record themselves (post-push hook). The Stop hook refuses to end your turn after a
push/PR/merge that has no matching event or is not linked to an item; it prints the exact `rf`
command to run. `rf ls --lane <you>` shows your cards. Never hand-edit register/WORK-REGISTER.md:
it is generated. No security details in any event text.
```
