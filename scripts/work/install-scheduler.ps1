<#
.SYNOPSIS
  Installs (or uninstalls) the "RouteFlow work board" scheduled task, which
  polls the GitHub work board every 5 minutes via scripts/work/run.mjs.

.DESCRIPTION
  This script only WRITES four things: a dedicated runner worktree at
  C:/ClaudeCode/rf-work-runner, a marker file (local-assets/work/.runner)
  inside it that run.mjs requires before it will fetch/checkout that
  worktree, a wrapper launcher inside that worktree's local-assets/work/,
  and a per-user Windows Scheduled Task. It never touches
  C:/ClaudeCode/routeflow or any other checkout, and it is NOT run
  automatically by anything in this repo -- an operator runs it once, by
  hand, to install the poller (or with -Uninstall to remove it).

  Each 5-minute run of the scheduled task launches a hidden (no console
  flash) wrapper that sets WORK_RUNNER=1 so run.mjs re-syncs the runner
  worktree to -Ref (git fetch + detach checkout) before reconciling -- see
  scripts/work/run.mjs for what happens each run. No npm install is ever
  performed here or by run.mjs; both are dependency-free Node ESM.

  -Ref, -Plane and -Triage are all re-runnable: running this script again
  (with the worktree already in place) does NOT skip the wrapper or the
  scheduled task -- it always rewrites run.cmd with the flags given this
  time and unregisters+re-registers the scheduled task, so e.g. adding
  -Triage to an existing install is just running the same command again
  with that switch added. Only the runner worktree itself and its marker
  file are created once and then left alone on later runs.

.PARAMETER Ref
  The git ref the runner worktree re-checks-out to on every run (passed
  through as WORK_RUNNER_REF). Default: origin/master.

.PARAMETER Plane
  Switch. When present, sets WORK_PLANE=1 so run.mjs also invokes
  scripts/work/plane-release-sync.mjs --apply, if that script exists.
  plane-release-sync.mjs is responsible for its own throttling.

.PARAMETER Triage
  Switch. When present, sets WORK_TRIAGE=1 so run.mjs also considers
  spawning a headless `claude -p ...` auto-triage run over the needs-triage
  backlog after each reconcile -- see run.mjs's "AUTO-TRIAGE" header
  section for the full trigger contract (fresh-work/backlog-age gate,
  60-minute minimum interval, 8-runs/day cap, and an in-flight guard).
  Off by default.

.PARAMETER Uninstall
  Removes the scheduled task and the wrapper launcher files. Leaves the
  runner worktree itself in place -- remove it by hand with
  `git -C C:/ClaudeCode/routeflow worktree remove C:/ClaudeCode/rf-work-runner`
  if you want that gone too.

.EXAMPLE
  powershell -File scripts\work\install-scheduler.ps1
.EXAMPLE
  powershell -File scripts\work\install-scheduler.ps1 -Ref origin/master -Plane
.EXAMPLE
  powershell -File scripts\work\install-scheduler.ps1 -Plane -Triage
.EXAMPLE
  powershell -File scripts\work\install-scheduler.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Ref = "origin/master",
  [switch]$Plane,
  [switch]$Triage,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$TaskName = "RouteFlow work board"
$MainRepo = "C:/ClaudeCode/routeflow"
$RunnerWorktree = "C:/ClaudeCode/rf-work-runner"
$RunnerWorkDir = Join-Path $RunnerWorktree "local-assets\work"
$RunCmdPath = Join-Path $RunnerWorkDir "run.cmd"
$RunVbsPath = Join-Path $RunnerWorkDir "run-hidden.vbs"
$RunnerMarkerPath = Join-Path $RunnerWorkDir ".runner"

function Uninstall-WorkScheduler {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  }
  else {
    Write-Host "Scheduled task '$TaskName' was not installed."
  }
  foreach ($f in @($RunCmdPath, $RunVbsPath)) {
    if (Test-Path $f) {
      Remove-Item $f -Force
      Write-Host "Removed $f"
    }
  }
  Write-Host "The runner worktree at $RunnerWorktree was left in place. Remove it yourself with:"
  Write-Host "  git -C $MainRepo worktree remove $RunnerWorktree"
}

if ($Uninstall) {
  Uninstall-WorkScheduler
  return
}

if (-not (Test-Path $MainRepo)) {
  throw "Main checkout not found at $MainRepo"
}

# ---- 1. Runner worktree ---------------------------------------------------
# A detached, code-only checkout that run.mjs re-syncs (fetch + checkout
# --detach) on every poll -- never the operator's own checkout(s). Created
# once here; every later run.mjs invocation keeps it current on its own.
if (-not (Test-Path $RunnerWorktree)) {
  Write-Host "Fetching $MainRepo before creating the runner worktree..."
  & git -C $MainRepo fetch -q origin
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)" }

  Write-Host "Creating runner worktree at $RunnerWorktree (ref: $Ref)..."
  & git -C $MainRepo worktree add --detach $RunnerWorktree $Ref
  if ($LASTEXITCODE -ne 0) { throw "git worktree add failed (exit $LASTEXITCODE)" }
}
else {
  Write-Host "Runner worktree already exists at $RunnerWorktree -- leaving it as is (run.mjs re-syncs it every run)."
}

New-Item -ItemType Directory -Force -Path $RunnerWorkDir | Out-Null

# ---- 1b. Runner marker -----------------------------------------------------
# run.mjs (WORK_RUNNER=1) refuses to fetch/checkout unless this file exists
# -- proof this worktree really is the dedicated runner one this installer
# creates/uses, not some other checkout with WORK_RUNNER=1 set by accident.
# Written (idempotently) whether the worktree above was just created or
# already existed.
if (-not (Test-Path $RunnerMarkerPath)) {
  Set-Content -Path $RunnerMarkerPath -Value "Created by install-scheduler.ps1 on $(Get-Date -Format o)" -Encoding ASCII
  Write-Host "Wrote runner marker: $RunnerMarkerPath"
}
else {
  Write-Host "Runner marker already present: $RunnerMarkerPath"
}

# ---- 2. Wrapper .cmd -------------------------------------------------------
# Sets the env run.mjs needs and runs it. No npm install: run.mjs and
# reconcile.mjs are dependency-free Node ESM, and node must already be on
# PATH for the interactive user account the task runs as.
$planeFlag = if ($Plane) { "1" } else { "0" }
$triageFlag = if ($Triage) { "1" } else { "0" }
$cmdContent = @"
@echo off
setlocal
set WORK_RUNNER=1
set WORK_RUNNER_REF=$Ref
set WORK_PLANE=$planeFlag
set WORK_TRIAGE=$triageFlag
cd /d "$RunnerWorktree"
rem Bootstrap: a runner created at a commit that predates scripts/work (e.g. installed before the
rem automation merged) can't sync itself, so fetch and move to the ref first.
if not exist scripts\work\run.mjs (
  git fetch -q origin
  git checkout -q --detach $Ref
)
if exist scripts\work\run.mjs node scripts\work\run.mjs
endlocal
"@
Set-Content -Path $RunCmdPath -Value $cmdContent -Encoding ASCII
Write-Host "Wrote wrapper: $RunCmdPath"

# ---- 3. Hidden launcher -----------------------------------------------------
# Task Scheduler's own "Hidden" setting only hides the TASK from the
# Task Scheduler UI list -- it does not stop the cmd.exe console window the
# action would otherwise flash open every 5 minutes. Launching the wrapper
# through WScript.Shell.Run with windowStyle 0 runs it fully hidden instead.
$vbsContent = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & "$RunCmdPath" & """", 0, False
"@
Set-Content -Path $RunVbsPath -Value $vbsContent -Encoding ASCII
Write-Host "Wrote hidden launcher: $RunVbsPath"

# ---- 4. Scheduled task ------------------------------------------------------
# Per-user, only while logged on (LogonType Interactive -- matches Task
# Scheduler's "Run only when user is logged on" radio button), every 5
# minutes, indefinitely, hidden from the task list. MultipleInstances
# IgnoreNew is a second, OS-level guard alongside run.mjs's own
# run.lock file.
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$RunVbsPath`""
# [TimeSpan]::MaxValue serializes to P99999999DT23H59M59S, which Register-ScheduledTask rejects
# (HRESULT 0x80041318) on Windows 10/11. Ten years is "indefinitely" for this purpose.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:UserName -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Scheduled task '$TaskName' already exists -- replacing its definition."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Polls RouteFlow's GitHub work board (scripts/work/reconcile.mjs) every 5 minutes from the dedicated runner worktree at $RunnerWorktree. Installed by scripts/work/install-scheduler.ps1." `
| Out-Null

Write-Host ""
Write-Host "Installed scheduled task '$TaskName' -- every 5 min, ref $Ref, plane=$planeFlag, triage=$triageFlag."
Write-Host "Uninstall with: powershell -File $($MyInvocation.MyCommand.Path) -Uninstall"
