# Run from inside your Agrova-INNOVATRIX Git repository root:
# powershell -NoProfile -ExecutionPolicy Bypass -File .\Agrova_Round2_Integration_Kit\SETUP-WINDOWS.ps1
$ErrorActionPreference = 'Stop'
$base = '0993656346ee0f29982695d6d4a9ea02084497e0'
$branch = 'round2-final-integration'
try {
  git rev-parse --show-toplevel | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Open PowerShell in the Git repository root.' }
  $changes = @(git status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or ($changes | Where-Object { $_ })) { throw 'Commit or stash tracked local modifications first. This script does not overwrite them.' }
  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed: check network or GitHub authentication.' }
  git cat-file -e "${base}^{commit}"
  if ($LASTEXITCODE -ne 0) { throw 'Reviewed Round 2 base commit not fetched.' }
  git show-ref --verify --quiet "refs/heads/$branch"
  if ($LASTEXITCODE -eq 0) {
    throw "$branch already exists. Review it rather than overwriting."
  }
  git switch -c $branch $base
  if ($LASTEXITCODE -ne 0) { throw 'Could not create final integration branch.' }
  node .\Agrova_Round2_Integration_Kit\INTEGRATE.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Integration failed; do not push.' }
  Push-Location .\agrova-v3
  try {
    node --check server.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Server syntax check failed.' }
    node --check public/app.js
    if ($LASTEXITCODE -ne 0) { throw 'Browser code syntax check failed.' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Automated tests failed.' }
    node scripts/check-ui-render.mjs
    if ($LASTEXITCODE -ne 0) { throw 'UI render regression tests failed.' }
    npm run smoke:isolated
    if ($LASTEXITCODE -ne 0) { throw 'Isolated smoke test failed.' }
  } finally { Pop-Location }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Git whitespace/diff checks failed.' }
  Write-Host "`nSUCCESS: All checks passed. NO files have been committed or pushed." -ForegroundColor Green
  Write-Host 'Review git diff, then commit/push only these project files:'
  Write-Host 'git add agrova-v3/public/app.js agrova-v3/server.mjs agrova-v3/scripts/check-ui-render.mjs agrova-v3/ROUND2_FINAL_TECH_NOTE.md'
  Write-Host 'git commit -m "feat(round2): integrate audited evidence history UI and full settlement review"'
  Write-Host 'git push -u origin round2-final-integration'
} catch {
  Write-Host "STOP: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
