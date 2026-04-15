# ============================================================================
#  TradingMCP — Disable all scheduled tasks (pause without removing)
#  Tasks remain registered but will NOT fire until re-enabled.
#
#  USAGE:  Right-click → "Run with PowerShell"
#  TO RE-ENABLE:  run enable_tasks.ps1
# ============================================================================

$TASK_NAMES = @(
    "TradingMCP_AsianOpen",
    "TradingMCP_LondonOpen",
    "TradingMCP_NYOpen",
    "TradingMCP_LondonClose",
    "TradingMCP_Research"
)

Write-Host ""
Write-Host "Disabling TradingMCP tasks (paused — not removed)..." -ForegroundColor Yellow
Write-Host ""

foreach ($name in $TASK_NAMES) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Disable-ScheduledTask -TaskName $name | Out-Null
        Write-Host "  ⏸ Disabled: $name" -ForegroundColor Yellow
    } else {
        Write-Host "  – Not found: $name" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "All tasks paused. Trading will NOT run automatically." -ForegroundColor Yellow
Write-Host "To resume: run enable_tasks.ps1" -ForegroundColor Gray
