Write-Host "AIVE Git auto-save running..." -ForegroundColor Cyan

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Stage all changes
git add .

# Check for changes
$status = git status --porcelain
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host "No changes to commit." -ForegroundColor Yellow
    exit 0
}

# Commit
git commit -m "Auto save $timestamp"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Commit failed." -ForegroundColor Red
    exit 1
}

# Push
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed. Changes committed locally." -ForegroundColor Red
    exit 1
}

Write-Host "Auto-save complete." -ForegroundColor Green
