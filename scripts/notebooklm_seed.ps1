<#
.SYNOPSIS
  Seed two NotebookLM notebooks for the trading setup.

.DESCRIPTION
  One-shot bootstrap for the NotebookLM connector (notebooklm-mcp-cli).
  Run AFTER `nlm login`. Creates two notebooks so theory and live system
  knowledge stay separated:

    1. "Trading Theory"  <- every PDF in the local trading library
    2. "Trading System"  <- live system/strategy docs from this repo (as text)

  The knowledge base lives in Google's cloud, so it is queryable from
  notebooklm.google.com anywhere, and from Claude Code via the
  notebooklm-mcp server (or `nlm notebook query <id> "..."`).

  Pass -TheoryOnly or -SystemOnly to build just one. Pass -SkipTheory /
  -SkipSystem to skip one. Re-running creates NEW notebooks unless you
  pass existing ids via -TheoryId / -SystemId.

.EXAMPLE
  pwsh scripts/notebooklm_seed.ps1
  pwsh scripts/notebooklm_seed.ps1 -SystemOnly
#>
param(
  [string]$LibraryDir = "C:\Users\Tda-d\OneDrive\Alpha\Desktop\Trading",
  [string]$TheoryTitle = "Trading Theory",
  [string]$SystemTitle = "Trading System",
  [string]$TheoryId = "",
  [string]$SystemId = "",
  [switch]$TheoryOnly,
  [switch]$SystemOnly,
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"
$profileArg = if ($Profile) { @("--profile", $Profile) } else { @() }
$repo = Split-Path $PSScriptRoot -Parent

function New-Notebook([string]$title) {
  Write-Host "Creating notebook '$title'..." -ForegroundColor Cyan
  $raw = & nlm notebook create $title --json @profileArg | Out-String
  try { $nb = $raw | ConvertFrom-Json } catch { $nb = $null }
  $id = if ($nb.id) { $nb.id } elseif ($nb.notebook_id) { $nb.notebook_id } else { "" }
  if (-not $id) {
    Write-Host "Could not parse notebook id. Raw output:" -ForegroundColor Yellow
    Write-Host $raw
    Write-Host "Find it with:  nlm notebook list" -ForegroundColor Yellow
    throw "notebook create failed"
  }
  Write-Host "  id: $id" -ForegroundColor Green
  return $id
}

# 1. Auth check ---------------------------------------------------------------
Write-Host "Checking NotebookLM auth..." -ForegroundColor Cyan
$auth = & nlm login --check @profileArg 2>&1 | Out-String
if ($auth -notmatch "authenticated|valid|OK|✓") {
  Write-Host "Not authenticated. Run:  nlm login" -ForegroundColor Red
  Write-Host $auth
  exit 1
}

$ok = 0; $fail = 0

# 2. Trading Theory notebook (PDF library) ------------------------------------
if (-not $SystemOnly) {
  if (-not $TheoryId) { $TheoryId = New-Notebook $TheoryTitle }
  $pdfs = Get-ChildItem -Path $LibraryDir -Filter *.pdf -File | Sort-Object Name
  Write-Host "Uploading $($pdfs.Count) PDFs -> '$TheoryTitle'" -ForegroundColor Cyan
  foreach ($pdf in $pdfs) {
    Write-Host "  + $($pdf.Name)" -NoNewline
    try {
      & nlm source add $TheoryId --file $pdf.FullName --wait @profileArg | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host "  ok" -ForegroundColor Green; $ok++ }
      else { Write-Host "  FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; $fail++ }
    } catch { Write-Host "  FAILED ($_)" -ForegroundColor Red; $fail++ }
  }
}

# 3. Trading System notebook (live repo docs as text) -------------------------
if (-not $TheoryOnly) {
  if (-not $SystemId) { $SystemId = New-Notebook $SystemTitle }
  $docs = @("TRADING_SYSTEM.md","GREED.md","README.md","BOOTSTRAP.md","RESEARCH.md","SETUP_GUIDE.md","CLAUDE.md")
  Write-Host "Uploading system docs -> '$SystemTitle'" -ForegroundColor Cyan
  foreach ($doc in $docs) {
    $p = Join-Path $repo $doc
    if (-not (Test-Path $p)) { continue }
    Write-Host "  + $doc" -NoNewline
    $content = Get-Content $p -Raw
    try {
      & nlm source add $SystemId --text $content --title $doc --wait @profileArg | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host "  ok" -ForegroundColor Green; $ok++ }
      else { Write-Host "  FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; $fail++ }
    } catch { Write-Host "  FAILED ($_)" -ForegroundColor Red; $fail++ }
  }
}

# 4. Summary ------------------------------------------------------------------
Write-Host ""
Write-Host "Done. $ok sources added, $fail failed." -ForegroundColor Cyan
if ($TheoryId) { Write-Host "Trading Theory id: $TheoryId" }
if ($SystemId) { Write-Host "Trading System id: $SystemId" }
Write-Host "Query example:  nlm notebook query $TheoryId ""What confirms a valid pin bar entry?"""
Write-Host "Note: 'Trading System' docs change over time — re-run with -SystemOnly to refresh."
