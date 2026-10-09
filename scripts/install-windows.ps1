$ErrorActionPreference = "Stop"

function Write-Log([string]$msg) { Write-Host "tkr: $msg" }
function Fail([string]$msg) { Write-Error "tkr install: $msg"; exit 1 }

try {
    $nodeVersion = [version]((node --version).TrimStart('v'))
    if ($LASTEXITCODE -ne 0) { Fail "Node.js 20.11+ is required." }
    if ($nodeVersion -lt [version]'20.11') { Fail "Node.js 20.11+ is required." }
} catch { Fail "Node.js 20.11+ is required." }

Write-Log "Installing @tokmizer/plugin from npm..."
npm.cmd install -g @tokmizer/plugin
if ($LASTEXITCODE -ne 0) { Fail "npm installation failed." }
if (-not (Get-Command tkr.cmd -ErrorAction SilentlyContinue)) { Fail "tkr is not on PATH. Add the npm global directory to PATH and run tkr shim install." }

tkr.cmd shim install
if ($LASTEXITCODE -ne 0) { Fail "Tokmizer setup failed. Fix the reported error and run tkr shim install again." }

$tokmizerDir = if ($env:TOKMIZER_HOME) { $env:TOKMIZER_HOME } else { Join-Path $env:USERPROFILE ".tokmizer" }
$shimsDir = Join-Path $tokmizerDir "shims"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $shimsDir) {
    [Environment]::SetEnvironmentVariable("Path", "$shimsDir;$userPath", "User")
}

Write-Log "Done. Open a new terminal. Tokmizer is free and does not require an account."
Write-Log "For Codex, also run: tkr setup-codex"
Write-Log "Check the installation with: tkr status"
