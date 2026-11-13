@echo off
setlocal
cd /d "%~dp0" || goto :end
echo.
echo ============================================================
echo  Set Screener.in Session Cookie
echo ============================================================
echo.
set /p SESS="Paste your Screener sessionid cookie here: "
if "%SESS%"=="" (
  echo No cookie entered.
  goto :end
)
echo.
node set-screener-cookie.js %SESS%
:end
echo.
pause
