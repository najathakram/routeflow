# Mac mini — fleet setup (2026-09-19)

Goal: the Mac runs lanes **R-service, R-ui, B, F2**; the PC keeps U, S, F, COORD, LEAD. Shared
board = GitHub issue **#938** (`gh issue comment 938 --body "[HH:MMZ] [X@mac] EVENT — detail"`).
One branch per session, never the same branch on both machines; prod ops only from the PC.

## Part A — owner, in Terminal on the Mac (≈30–45 min, mostly downloads)

**Where the repo lives:** on the internal disk, `~/code/routeflow` (≈ `/Users/maznahamanullah/code/routeflow`).
Not on `/Volumes/Volume E/…`: the space in the path breaks unquoted shell scripts and Docker bind
mounts, external volumes are slower for `node_modules`/Docker, and macOS often mounts them with
"ignore ownership", which breaks executable bits in `node_modules/.bin`. The external volume can
hold proofs/backups (`local-assets/` can be a symlink to it) — never the working tree.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git gh node@20 postgresql@16
brew install --cask docker
echo 'export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile
npm install -g npm@10.8.0 @anthropic-ai/claude-code
gh auth login          # same GitHub account; choose HTTPS + browser
git config --global user.name "Najath Akram" && git config --global user.email "najathakram1@gmail.com"
git config --global core.autocrlf input
open -a Docker         # then Docker Desktop → Settings → Resources: ≥ 12 GB memory, 4+ CPUs
mkdir -p ~/code && cd ~/code && git clone https://github.com/najathakram/routeflow.git && cd routeflow
claude                 # log into the SAME Claude account; exit after login
```

Copy these from the PC to the Mac (AirDrop/USB/iCloud — a zip is fine):
- `C:\Users\nakram\.claude\CLAUDE.md` → `~/.claude/CLAUDE.md`
- `C:\Users\nakram\.claude\skills\{bug-pipeline,code-map,dev-pipeline,lessons-learned,model-routing,pre-merge-review,feature-plan}` → `~/.claude/skills/`
- `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\memory\` → `~/.claude/projects/<slug>/memory/` — the slug appears under `~/.claude/projects/` after the first `claude` launch inside `~/code/routeflow` (it is the repo path with `/` turned into `-`).
- `C:\ClaudeCode\routeflow\local-assets\handoff\2026-09-19\` (lane prompts, evaluation, MAC-SETUP) → `~/code/routeflow/local-assets/handoff/2026-09-19/` (gitignored).

## Part B — first Claude Code session on the Mac (window title: "RouteFlow Mac setup", Sonnet)

Paste:

> You are the setup session for the RouteFlow fleet's second machine (Mac mini). Repo: `~/code/routeflow`. Read `CLAUDE.md`, then `local-assets/handoff/2026-09-19/MAC-SETUP.md` and `lane-prompts/LANE-COMMON.md`. Do, in order, stopping and reporting at the first failure: (1) `node -v` (20.x), `npm -v` (10.8.0), `gh auth status`, `docker info` (running, ≥ 12 GB), `pg_dump --version` (16), `git config core.autocrlf` (= input), `.gitattributes` present; (2) `npm ci`; `npx playwright install chromium`; (3) `docker compose ls` then `npm run local:up` → `npm run local:seed` → `npm run local:validate` → `npm run local:validate:features` → `npm run local:e2e` — all green = machine CERTIFIED; paste the last 10 lines of each; (4) confirm the house skills and memory were copied (`ls ~/.claude/skills`, `ls ~/.claude/projects/*/memory | wc -l` ≈ 250) and that `.claude/hooks/stop.mjs` runs (`node .claude/hooks/stop.mjs --help` or its self-test); (5) `npm run check-types` and `npx jest --selectProjects api --listTests` resolve; (6) post `[HH:MMZ] [SETUP@mac] DONE — node/npm/docker/pg versions, local:validate + local:e2e green` as a comment on GitHub issue #938 (`gh issue comment 938 --body "..."`). Never run `railway`, never touch prod, never create branches. Report the certification result to the owner in ≤ 10 lines.

## Part C — open the Mac lanes (after CERTIFIED)

Four sessions, Sonnet, each pasted its brief with the Mac paths:

- **"RouteFlow Lane R-service"** → `lane-prompts/LANE-COMMON.md` + `LANE-R.md` (steps 1–3). Worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-service`.
- **"RouteFlow Lane R-ui"** → same files (steps 4–6; wait for step 1's PR on issue #938 before wiring). Worktree `~/code/routeflow/.claude/worktrees/rf-lane-R-ui`.
- **"RouteFlow Lane B"** → `LANE-COMMON.md` + `LANE-B.md`. Worktree `~/code/routeflow/.claude/worktrees/rf-lane-B`.
- **"RouteFlow F2 prover"** → `LANE-COMMON.md` + `LANE-F2.md`. Owns the Mac compose stack.

Prefix each paste with: "Machine = mac. Board = GitHub issue #938 (read with `gh issue view 938 --comments`, append with `gh issue comment 938`). The repo is `~/code/routeflow`; worktrees live INSIDE it under `.claude/worktrees/`; replace any `C:/ClaudeCode/routeflow/...` path in the brief with `~/code/routeflow/...`.""
