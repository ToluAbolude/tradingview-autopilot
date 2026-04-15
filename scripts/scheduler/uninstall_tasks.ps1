# ============================================================================
#  TradingMCP — Windows Task Scheduler Uninstaller
#  Permanently removes ALL TradingMCP scheduled tasks.
#
#  USAGE:  Right-click → "Run with PowerShell"
#
#  To DISABLE (pause) without removing, use:  disable_tasks.ps1
#  To RE-ENABLE after disabling, use:         enable_tasks.ps1
# ============================================================================

$TASK_NAMES = @(
    "TradingMCP_AsianOpen",
    "TradingMCP_LondonOpen",
    "TradingMCP_NYOpen",
    "TradingMCP_LondonClose",
    "TradingMCP_Research"
)

$removed = 0
$notFound = 0

Write-Host ""
Write-Host "Removing TradingMCP scheduled tasks..." -ForegroundColor Cyan
Write-Host ""

foreach ($name in $TASK_NAMES) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "  ✓ Removed: $name" -ForegroundColor Green
        $removed++
    } else {
        Write-Host "  – Not found: $name (already removed)" -ForegroundColor Gray
        $notFound++
    }
}

# Also try to remove the task folder if empty
try {
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $folder = $scheduler.GetFolder("\TradingMCP")
    $tasks = $folder.GetTasks(0)
    if ($tasks.Count -eq 0) {
        $root = $scheduler.GetFolder("\")
        $root.DeleteFolder("TradingMCP", 0)
        Write-Host "  ✓ Removed task folder: TradingMCP" -ForegroundColor Green
    }
} catch {
    # Folder may already be gone — no action needed
}

Write-Host ""
Write-Host "Done. $removed task(s) removed, $notFound already absent." -ForegroundColor Cyan
Write-Host "To reinstall, run: install_tasks.ps1" -ForegroundColor Gray
