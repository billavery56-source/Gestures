# github-replace-from-origin.ps1
# Replaces workspace files with what's in GitHub by cloning to a temp folder,
# then robocopy mirror into the workspace while preserving .vscode (and .git).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[ERR ] $msg" -ForegroundColor Red }

# Workspace is parent of .vscode
$workspace = Split-Path -Parent $PSScriptRoot

Write-Info "Workspace: $workspace"

# Determine repo URL from existing repo if present
$repoUrl = $null
if (Test-Path (Join-Path $workspace ".git")) {
  try {
    $repoUrl = (git -C $workspace config --get remote.origin.url) 2>$null
    if ($repoUrl) { $repoUrl = $repoUrl.Trim() }
  } catch {
    $repoUrl = $null
  }
}

if (-not $repoUrl) {
  Write-Warn "Couldn't detect remote.origin.url in this workspace."
  $repoUrl = Read-Host "Paste GitHub repo URL (HTTPS or SSH)"
}

if (-not $repoUrl) {
  throw "Repo URL is required."
}

Write-Info "Repo URL: $repoUrl"

# Create a temp clone folder next to the workspace
$parent = Split-Path -Parent $workspace
$stamp  = Get-Date -Format "yyyyMMdd_HHmmss"
$temp   = Join-Path $parent "_github_pull_tmp_$stamp"

Write-Info "Temp clone folder: $temp"

try {
  # Clone
  Write-Info "Cloning repo..."
  git clone $repoUrl $temp

  if (-not (Test-Path $temp)) {
    throw "Clone failed; temp folder not found."
  }

  # Mirror copy into workspace BUT preserve these folders
  # /MIR makes destination match source (including deletions)
  $excludeDirs = @(".git", ".vscode", "node_modules")
  $xdArgs = @()
  foreach ($d in $excludeDirs) { $xdArgs += @("/XD", $d) }

  Write-Info "Replacing workspace files from GitHub (preserving .vscode)..."
  Write-Warn "This will OVERWRITE files in the workspace (except excluded folders)."

  $rc = robocopy $temp $workspace /MIR @xdArgs /R:1 /W:1 /NFL /NDL /NP
  # Robocopy exit codes: 0-7 are success-ish; 8+ are failures
  if ($LASTEXITCODE -ge 8) {
    throw "Robocopy failed with exit code $LASTEXITCODE"
  }

  Write-Info "Done. Workspace now matches GitHub (except .vscode/.git/node_modules)."
}
finally {
  if (Test-Path $temp) {
    Write-Info "Cleaning up temp folder..."
    Remove-Item -Recurse -Force $temp
  }
}
