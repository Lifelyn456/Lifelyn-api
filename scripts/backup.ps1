param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = "Stop"
if (-not $env:DATABASE_URL) { throw "DATABASE_URL is required." }
$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $OutputPath))
if (-not (Test-Path -LiteralPath $resolvedParent)) { throw "Backup destination directory does not exist." }
pg_dump --dbname $env:DATABASE_URL --format custom --no-owner --no-acl --file $OutputPath
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed." }
Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
