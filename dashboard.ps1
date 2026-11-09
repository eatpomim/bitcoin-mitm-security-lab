param(
    [ValidateSet('Install','Build','Start','Test','Integration')]
    [string]$Action = 'Start',
    [string]$BindAddress = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$portable = Join-Path $PSScriptRoot '.tools\node-v22.23.4-win-x64'
if (Test-Path (Join-Path $portable 'node.exe')) { $env:Path = "$portable;$env:Path" }
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS first.' }
switch ($Action) {
    'Install' {
        Push-Location (Join-Path $PSScriptRoot 'app')
        try { npm.cmd install --no-audit --no-fund --cache ../.local/npm-cache }
        finally { Pop-Location }
    }
    'Build' { npm.cmd run build }
    'Test' { npm.cmd test }
    'Integration' { npm.cmd run test:integration }
    'Start' { $env:LAB_HOST = $BindAddress; node server/index.mjs }
}
if ($LASTEXITCODE -ne 0) { throw "Command failed: $LASTEXITCODE" }
