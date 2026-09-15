param(
  [Parameter(Mandatory = $true)][string]$BackupPath
)
$ErrorActionPreference = "Stop"
if (-not $env:LIFELYN_RESTORE_TEST_DATABASE_URL) {
  throw "LIFELYN_RESTORE_TEST_DATABASE_URL is required and must reference an empty, disposable database."
}
if ($env:LIFELYN_RESTORE_TEST_DATABASE_URL -eq $env:DATABASE_URL) {
  throw "Refusing to restore into the source database."
}
if (-not (Test-Path -LiteralPath $BackupPath)) { throw "Backup file was not found." }
pg_restore --dbname $env:LIFELYN_RESTORE_TEST_DATABASE_URL --clean --if-exists --no-owner --no-acl $BackupPath
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed." }
psql $env:LIFELYN_RESTORE_TEST_DATABASE_URL -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM "_prisma_migrations";'
if ($LASTEXITCODE -ne 0) { throw "Restored migration verification failed." }
