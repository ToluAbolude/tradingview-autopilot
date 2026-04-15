# ============================================================================
#  Removes TradingView auto-launch from Windows Startup folder.
#  TradingView will no longer start automatically at login.
#
#  USAGE:  Right-click -> "Run with PowerShell"
# ============================================================================

$STARTUP_DIR = [System.Environment]::GetFolderPath("Startup")
$SHORTCUT    = "$STARTUP_DIR\TradingMCP_TradingView.lnk"

if (Test-Path $SHORTCUT) {
    Remove-Item $SHORTCUT -Force
    Write-Host ""
    Write-Host "Removed. TradingView will no longer auto-launch at login." -ForegroundColor Green
    Write-Host "To re-add: run add_tv_startup.ps1" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "Not found - startup entry was already removed." -ForegroundColor Yellow
}
Write-Host ""
