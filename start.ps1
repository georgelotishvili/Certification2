Param()

$ErrorActionPreference = 'Stop'

# Resolve paths based on this script location (works even if launched from elsewhere)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'

# Helper: stop any process listening on a port (best-effort)
function Stop-Port {
  param([int]$Port)
  try {
    $pids = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($pid in $pids) { if ($pid) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } }
  } catch {}
}

# Free common dev ports so the new servers can bind
Stop-Port -Port 3000
Stop-Port -Port 8000

# Choose Python launcher automatically
$pyCmd = 'py -3'
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { $pyCmd = 'python' }

# Backend window
$backendCmd = @"
Set-Location -LiteralPath '$backend'
if (!(Test-Path '.venv\Scripts\Activate.ps1')) { $pyCmd -m venv .venv }
. .\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
"@
Start-Process powershell -ArgumentList @('-NoExit','-Command', $backendCmd) | Out-Null

# Frontend window
$frontendCmd = @"
Set-Location -LiteralPath '$root'
$pyCmd -m http.server 3000 --bind 127.0.0.1
"@
Start-Process powershell -ArgumentList @('-NoExit','-Command', $frontendCmd) | Out-Null

Start-Sleep -Seconds 2
Start-Process 'http://127.0.0.1:3000/frontend/pages/index.html' | Out-Null

Write-Host "Started: Frontend http://127.0.0.1:3000  | Backend http://127.0.0.1:8000" -ForegroundColor Green


