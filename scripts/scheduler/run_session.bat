@echo off
:: TradingMCP session runner wrapper
:: Called by Windows Task Scheduler — handles node path with spaces and logging

set WORK_DIR=C:\Users\Tda-d\tradingview-autopilot
set NODE="C:\Program Files\nodejs\node.exe"
set SCRIPT=%WORK_DIR%\scripts\trading\session_runner.mjs
set LOG_DIR=%WORK_DIR%\data\trade_log\scheduler_logs

:: Create log dir if missing
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Log file named by date+time
for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set DATESTAMP=%%d%%b%%c
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set TIMESTAMP=%%a%%b
set LOGFILE=%LOG_DIR%\session_%DATESTAMP%_%TIMESTAMP%.log

echo [%DATE% %TIME%] Session started >> "%LOGFILE%"
cd /d "%WORK_DIR%"
%NODE% "%SCRIPT%" >> "%LOGFILE%" 2>&1
echo [%DATE% %TIME%] Session ended (exit code %ERRORLEVEL%) >> "%LOGFILE%"
