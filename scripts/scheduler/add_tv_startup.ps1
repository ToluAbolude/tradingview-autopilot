# ============================================================================
#  Adds TradingView auto-launch (with CDP) to Windows Startup folder.
#  Runs silently at every login — no window, no prompt.
#
#  USAGE:  Right-click -> "Run with PowerShell"
#  TO REMOVE: run remove_tv_startup.ps1
# ============================================================================

$STARTUP_DIR = [System.Environment]::GetFolderPath("Startup")
$VBS_SOURCE  = "C:\Users\Tda-d\tradingview-autopilot\scripts\scheduler\startup_tradingview.vbs"
$SHORTCUT    = "$STARTUP_DIR\TradingMCP_TradingView.lnk"

if (-not (Test-Path $VBS_SOURCE)) {
    Write-Error "Launcher not found: $VBS_SOURCE"
    exit 1
}

# Create shortcut pointing to wscript.exe (runs VBS silently)
$shell = New-Object -ComObject WScript.Shell
$sc    = $shell.CreateShortcut($SHORTCUT)
$sc.TargetPath       = "wscript.exe"
$sc.Arguments        = "`"$VBS_SOURCE`""
$sc.WorkingDirectory = Split-Path $VBS_SOURCE
$sc.Description      = "TradingMCP: Launch TradingView with CDP on port 9222"
$sc.WindowStyle      = 7   # minimised / hidden
$sc.Save()

Write-Host ""
Write-Host "Done. TradingView will auto-launch at every Windows login." -ForegroundColor Green
Write-Host ""
Write-Host "Shortcut placed at:" -ForegroundColor Cyan
Write-Host "  $SHORTCUT" -ForegroundColor Gray
Write-Host ""
Write-Host "Behaviour:" -ForegroundColor Yellow
Write-Host "  - Waits 5s after login before launching (lets desktop settle)" -ForegroundColor Yellow
Write-Host "  - Skips launch if TradingView + CDP already running" -ForegroundColor Yellow
Write-Host "  - Tries traditional install, falls back to Store version" -ForegroundColor Yellow
Write-Host "  - Runs completely silently (no window)" -ForegroundColor Yellow
Write-Host ""
Write-Host "To remove: run remove_tv_startup.ps1" -ForegroundColor Gray
