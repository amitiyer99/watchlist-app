# Registers the Watchlist daily refresh as a Windows Scheduled Task.
# Runs refresh-all.bat Mon-Fri at 08:30, in your interactive logged-in session
# (so the NSE browser window can appear), and — crucially — catches up as soon as
# you next turn the laptop on / log in if 08:30 was missed (StartWhenAvailable).
# No admin rights needed; the task runs as you, only when you're logged on.

$ErrorActionPreference = 'Stop'
$task = 'Watchlist Daily Refresh'
$bat  = Join-Path $PSScriptRoot 'refresh-all.bat'

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $bat + '"') -WorkingDirectory $PSScriptRoot
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '8:30AM'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host ""
Write-Host "Scheduled '$task':"
Write-Host "  - Runs Mon-Fri at 08:30 while you're logged in."
Write-Host "  - If the laptop was off/asleep at 08:30, it runs as soon as you next log in that day."
Write-Host "  - Test now:  schtasks /run /tn `"$task`""
Write-Host "  - Status:    schtasks /query /tn `"$task`""
Write-Host "  - Remove:    schtasks /delete /tn `"$task`" /f"
Write-Host "  - Log:       refresh-all.log  in this folder"
