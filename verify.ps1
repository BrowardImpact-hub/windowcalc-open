# verify.ps1 - proves this checkout runs. From the repo root:  .\verify.ps1
# The same checks CI runs (.github/workflows/ci.yml), on your own machine.
# Uses a throwaway SQLite database in %TEMP%; never touches production.

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run:  py -3.12 -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}
$results = [ordered]@{}

Write-Host "`n[1/4] Python compiles" -ForegroundColor Cyan
& $py -m py_compile server.py pricing_engine.py run_local.py
$results['python compiles'] = ($LASTEXITCODE -eq 0)

Write-Host "[2/4] Browser JavaScript parses" -ForegroundColor Cyan
if (Get-Command node -ErrorAction SilentlyContinue) {
    node --check static/app.js; $a = $LASTEXITCODE
    node --check static/sw.js;  $b = $LASTEXITCODE
    $results['javascript parses'] = ($a -eq 0 -and $b -eq 0)
} else {
    Write-Host "  node not found - install Node.js 20+" -ForegroundColor Yellow
    $results['javascript parses'] = $false
}

Write-Host "[3/4] Server boots on a throwaway SQLite database" -ForegroundColor Cyan
$work = Join-Path $env:TEMP ("windowcalc_verify_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$port = 8765
$env:DB_PATH = Join-Path $work 'verify.db'
$env:SEED_DEMO_DATA = '1'
$env:CHAT_MEDIA_STORAGE = 'local'
$env:PORT = "$port"
$proc = Start-Process -FilePath $py -ArgumentList 'server.py' -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $work 'server.out.log') -RedirectStandardError (Join-Path $work 'server.err.log')
$base = "http://127.0.0.1:$port"
$health = $null
for ($i = 0; $i -lt 90 -and -not $health; $i++) {
    Start-Sleep -Seconds 1
    try { $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5 } catch { if ($proc.HasExited) { break } }
}
$results['server boots (health ok)'] = [bool]($health -and $health.status -eq 'ok')

Write-Host "[4/4] Routes answer correctly" -ForegroundColor Cyan
function Get-Code([string]$url) {
    try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}
$index  = Get-Code "$base/"
$locked = Get-Code "$base/api/quotes"
Write-Host "  / -> $index    /api/quotes without login -> $locked"
$results['routes (/ 200, api 401)'] = ($index -eq 200 -and $locked -eq 401)

if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Remove-Item Env:DB_PATH, Env:SEED_DEMO_DATA, Env:CHAT_MEDIA_STORAGE, Env:PORT -ErrorAction SilentlyContinue

Write-Host "`n================ VERDICT ================" -ForegroundColor Cyan
if ($health) { Write-Host ("  app {0} | schema {1} | pricing engine {2}" -f $health.app_version, $health.schema_version, $health.pricing_engine_version) }
$failed = 0
foreach ($k in $results.Keys) {
    $ok = [bool]$results[$k]
    if (-not $ok) { $failed++ }
    Write-Host ("  {0,-26} {1}" -f $k, $(if ($ok) {'PASS'} else {'FAIL'})) -ForegroundColor $(if ($ok) {'Green'} else {'Red'})
}
Write-Host "  logs: $work`n"
if ($failed -gt 0) { exit 1 }
Write-Host "  This checkout is verified.`n" -ForegroundColor Green
exit 0
