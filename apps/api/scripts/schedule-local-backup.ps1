# schedule-local-backup.ps1
# Registers a Windows Task Scheduler job that runs backup-production.mjs daily.
# Run once from an elevated (Admin) PowerShell terminal:
#
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\apps\api\scripts\schedule-local-backup.ps1
#
# The task runs at 07:00 every morning, requires the machine to be on and
# the Railway CLI to be authenticated (railway login) and linked (railway link).
# For a more reliable alternative, use the GitHub Actions workflow instead.

$TaskName  = "RouteFlow-DB-Backup"
$ScriptDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # repo root
$Railway   = (Get-Command railway -ErrorAction SilentlyContinue).Source   # Railway CLI on PATH
$Script    = "apps\api\scripts\backup-production.mjs"   # relative to the repo root (WorkingDirectory)
$LogFile   = "$ScriptDir\backups\task-scheduler.log"

if (-not $Railway) {
    Write-Error "Railway CLI not found on PATH - npm install -g @railway/cli, then railway login and railway link."
    exit 1
}

# backup-production.mjs needs the postgres service's variables, so it runs under `railway run`.
$Action  = New-ScheduledTaskAction -Execute $Railway -Argument "run --service postgres node $Script scheduled" -WorkingDirectory $ScriptDir
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
Write-Host "  Script: $Script (under railway run --service postgres)"
Write-Host ""
Write-Host "  To run immediately:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  To remove:           Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  To view in UI:       taskschd.msc"
Write-Host ""
Write-Host "  NOTE: The GitHub Actions workflow (db-backup.yml) is more reliable"
Write-Host "  because it doesn't require your machine to be on."
