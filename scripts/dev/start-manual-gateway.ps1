param(
  [int]$Port = 18789
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$manualRoot = Join-Path $repoRoot ".tmp\manual-instance"
$homeDir = Join-Path $manualRoot "home"
$stateDir = Join-Path $manualRoot "state"
$configPath = Join-Path $stateDir "openclaw.json"

New-Item -ItemType Directory -Force $homeDir | Out-Null
New-Item -ItemType Directory -Force $stateDir | Out-Null

$gatewayProcs = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match "openclaw\.mjs gateway run" -or
  $_.CommandLine -match "scripts/run-node\.mjs gateway run"
}

foreach ($proc in $gatewayProcs) {
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
  } catch {
  }
}

$env:OPENCLAW_HOME = $homeDir
$env:OPENCLAW_STATE_DIR = $stateDir
$env:OPENCLAW_CONFIG_PATH = $configPath
$env:OPENCLAW_DISABLE_CONFIG_CACHE = "1"
$env:OPENCLAW_DEBUG_REPLY_ROUTING = "1"

Set-Location $repoRoot
node openclaw.mjs gateway run --dev --port $Port --allow-unconfigured
