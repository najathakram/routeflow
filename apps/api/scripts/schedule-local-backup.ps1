# schedule-local-backup.ps1
# Registers a Windows Task Scheduler job that runs backup-production.mjs daily.
# Run once from an elevated (Admin) PowerShell terminal:
#
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\apps\api\scripts\schedule-local-backup.ps1
#
# The task runs at 07:00 every morning, requires the machine to be on and
# the Railway CLI to be authenticated (railway login) and linked (railway link, run once
# from the repo root). Output (including any failure) is appended to backups\task-scheduler.log.
# For a more reliable alternative, use the GitHub Actions workflow instead.

$TaskName  = "RouteFlow-DB-Backup"
# This file lives in <repo>\apps\api\scripts, so the repo root is THREE levels up.
$ScriptDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$Railway   = (Get-Command railway -ErrorAction SilentlyContinue).Source   # Railway CLI on PATH
$Script    = "apps\api\scripts\backup-production.mjs"   # relative to the repo root (WorkingDirectory)
$BackupDir = "$ScriptDir\backups"
$LogFile   = "$BackupDir\task-scheduler.log"

if (-not $Railway) {
    Write-Error "Railway CLI not found on PATH - npm install -g @railway/cli, then railway login and railway link."
    exit 1
}
if (-not (Test-Path (Join-Path $ScriptDir $Script))) {
    Write-Error "Cannot find $Script under $ScriptDir - run this from a full repo checkout."
    exit 1
}
New-Item -ItemType Directory -Force $BackupDir | Out-Null

# backup-production.mjs needs the postgres service's variables, so it runs under `railway run`.
# cmd.exe /c so stdout AND stderr land in the log: a silent scheduled non-backup is the worst
# failure mode this task has, and Task Scheduler alone only shows a last-result code.
$Command = "`"$Railway`" run --service postgres node $Script scheduled >> `"$LogFile`" 2>&1"
$Action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $Command" -WorkingDirectory $ScriptDir
$Trigger = New-ScheduledTaskTrigger -Daily -At "07:00"
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable   # runs even if machine was off at trigger time

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   $Trigger `
    -Settings  $Settings `
    -RunLevel  Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered."
Write-Host "  Runs: daily at 07:00"
Write-Host "  Script: $Script (under railway run --service postgres), from $ScriptDir"
Write-Host "  Log:    $LogFile"
Write-Host ""
Write-Host "  To run immediately:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  To remove:           Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  To view in UI:       taskschd.msc"
Write-Host ""
Write-Host "  NOTE: The GitHub Actions workflow (db-backup.yml) is more reliable"
Write-Host "  because it doesn't require your machine to be on."
