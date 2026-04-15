# ============================================================================
#  TradingMCP - Windows Task Scheduler Installer
#  Registers 5 automated trading session tasks.
#
#  USAGE:  Right-click -> "Run with PowerShell"
#  TO REMOVE:   run uninstall_tasks.ps1
#  TO DISABLE:  run disable_tasks.ps1
#  TO ENABLE:   run enable_tasks.ps1
# ============================================================================

$NODE     = "C:\Program Files\nodejs\node.exe"
$WORK_DIR = "C:\Users\Tda-d\tradingview-autopilot"
$SCRIPT   = "$WORK_DIR\scripts\trading\session_runner.mjs"
$LOG_DIR  = "$WORK_DIR\data\trade_log\scheduler_logs"
$USER     = $env:USERNAME

if (-not (Test-Path $NODE)) {
    $found = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($found) { $NODE = $found }
    else {
        Write-Error "node.exe not found. Install Node.js from https://nodejs.org"
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

# Each task: Name, Schedule (/sc), Days (/d), Start time (/st)
$tasks = @(
    @{ Name="TradingMCP_AsianOpen";   SC="DAILY";  Days="*";           Time="01:07"; Label="Asian Open   (daily 01:07)" },
    @{ Name="TradingMCP_LondonOpen";  SC="WEEKLY"; Days="MON,TUE,WED,THU,FRI"; Time="09:07"; Label="London Open  (weekdays 09:07)" },
    @{ Name="TradingMCP_NYOpen";      SC="WEEKLY"; Days="MON,TUE,WED,THU,FRI"; Time="14:07"; Label="NY Open      (weekdays 14:07)" },
    @{ Name="TradingMCP_LondonClose"; SC="WEEKLY"; Days="MON,TUE,WED,THU,FRI"; Time="18:03"; Label="London Close (weekdays 18:03)" },
    @{ Name="TradingMCP_Research";    SC="WEEKLY"; Days="SUN";         Time="04:03"; Label="Research     (Sundays  04:03)" }
)

Write-Host ""
Write-Host "Registering TradingMCP scheduled tasks..." -ForegroundColor Cyan
Write-Host ""

foreach ($t in $tasks) {
    # Delete if already exists
    schtasks /delete /tn $t.Name /f 2>$null | Out-Null

    if ($t.SC -eq "DAILY") {
        $result = schtasks /create /tn $t.Name /sc DAILY /st $t.Time `
            /tr "`"$WORK_DIR\scripts\scheduler\run_session.bat`"" `
            /ru $USER /rl LIMITED /f 2>&1
    } else {
        $result = schtasks /create /tn $t.Name /sc WEEKLY /d $t.Days /st $t.Time `
            /tr "`"$WORK_DIR\scripts\scheduler\run_session.bat`"" `
            /ru $USER /rl LIMITED /f 2>&1
    }

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK  $($t.Name)  [$($t.Label)]" -ForegroundColor Green
    } else {
        Write-Host "  FAIL $($t.Name): $result" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Done. Open Task Scheduler to verify: Win+R -> taskschd.msc" -ForegroundColor Cyan
Write-Host ""
Write-Host "SESSION TIMES (UK local - BST summer / GMT winter):" -ForegroundColor Yellow
Write-Host "  01:07 - Asian Open   (crypto, daily)"          -ForegroundColor Yellow
Write-Host "  09:07 - London Open  (weekdays)"               -ForegroundColor Yellow
Write-Host "  14:07 - NY Open      (weekdays, TOP PRIORITY)"  -ForegroundColor Yellow
Write-Host "  18:03 - London Close (weekdays)"               -ForegroundColor Yellow
Write-Host "  04:03 - Research     (Sundays)"                -ForegroundColor Yellow
Write-Host ""
Write-Host "IMPORTANT: TradingView Desktop must be running at each time." -ForegroundColor Red
Write-Host "Logs: $LOG_DIR" -ForegroundColor Gray
