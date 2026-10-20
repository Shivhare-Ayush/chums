@echo off
echo Stopping Chums Hub and Agent Bridge processes...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*hub.mjs*' -or $_.CommandLine -like '*chums-agent-bridge.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped PID ' + $_.ProcessId) }"
echo Done.
