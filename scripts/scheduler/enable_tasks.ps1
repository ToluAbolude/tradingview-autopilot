# ============================================================================
#  TradingMCP — Re-enable all scheduled tasks
#  Resumes tasks that were paused with disable_tasks.ps1
#
#  USAGE:  Right-click → "Run with PowerShell"
# ============================================================================

$TASK_NAMES = @(
    "TradingMCP_AsianOpen",
    "TradingMCP_LondonOpen",
    "TradingMCP_NYOpen",
    "TradingMCP_LondonClose",
    "TradingMCP_Research"
)

Write-Host ""
Write-Host "Re-enabling TradingMCP tasks..." -ForegroundColor Cyan
Write-Host ""

foreach ($name in $TASK_NAMES) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Enable-ScheduledTask -TaskName $name | Out-Null
        $nextRun = (Get-ScheduledTaskInfo -TaskName $name).NextRunTime
        Write-Host "  ✓ Enabled: $name  (next run: $nextRun)" -ForegroundColor Green
    } else {
        Write-Host "  – Not found: $name  (run install_tasks.ps1 first)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "All tasks active. Trading sessions will run automatically." -ForegroundColor Green
