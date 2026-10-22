$ErrorActionPreference = "Stop"

function Write-Log([string]$msg) { Write-Host "tkr: $msg" }
function Fail([string]$msg) { Write-Error "tkr install: $msg"; exit 1 }

try {
    $nodeVersion = [version]((node --version).TrimStart('v'))
    if ($LASTEXITCODE -ne 0) { Fail "Node.js 24.22.1+ (or 22.23.4+) is required." }
    $patched = ($nodeVersion.Major -eq 22 -and $nodeVersion -ge [version]'22.23.4') -or ($nodeVersion.Major -eq 24 -and $nodeVersion -ge [version]'24.22.1') -or ($nodeVersion.Major -eq 26 -and $nodeVersion -ge [version]'26.12.1') -or $nodeVersion.Major -gt 26
    if (-not $patched) { Fail "Node.js 24.22.1+ (or 22.23.4+) is required." }
} catch { Fail "Node.js 24.22.1+ (or 22.23.4+) is required." }

Write-Log "Installing @tokmizer/plugin from npm..."
npm.cmd install -g @tokmizer/plugin
if ($LASTEXITCODE -ne 0) { Fail "npm installation failed." }
if (-not (Get-Command tkr.cmd -ErrorAction SilentlyContinue)) { Fail "tkr is not on PATH. Add the npm global directory to PATH and run tkr shim install." }

tkr.cmd shim install
if ($LASTEXITCODE -ne 0) { Fail "Tokmizer setup failed. Fix the reported error and run tkr shim install again." }

Write-Log "Done. Open a new terminal. Tokmizer is free and does not require an account."
Write-Log "For Codex, also run: tkr setup-codex"
Write-Log "Check the installation with: tkr status"
