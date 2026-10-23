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
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# Screener.in login can only be read while Chrome is closed. If 08:30 finds
# Chrome open, this second task retries through the afternoon and publishes
# the two lists once Chrome has been closed.
$catch = 'Watchlist Screener Catchup'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  $catchAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $PSScriptRoot 'scripts\screener-catchup.js') + '"') -WorkingDirectory $PSScriptRoot
  $catchTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '9:00AM'
  $rep = (New-ScheduledTaskTrigger -Once -At '9:00AM' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 11)).Repetition
  $catchTrigger.Repetition = $rep
  $catchSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $catch -Action $catchAction -Trigger $catchTrigger -Settings $catchSettings -Force | Out-Null
}

Write-Host ""
Write-Host "Scheduled '$task':"
Write-Host "  - Runs Mon-Fri at 08:30 while you're logged in, including on battery."
Write-Host "  - If the laptop was off/asleep at 08:30, it runs as soon as you next log in that day."
Write-Host "  - Screener.in and Marquee Investors retry every 30 min until 8pm if Chrome was open at 08:30."
Write-Host "  - Test now:  schtasks /run /tn `"$task`""
Write-Host "  - Status:    schtasks /query /tn `"$task`""
Write-Host "  - Remove:    schtasks /delete /tn `"$task`" /f"
Write-Host "  - Log:       refresh-all.log  in this folder"
