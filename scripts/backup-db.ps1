# scripts/backup-db.ps1
#
# Scheduled-task wrapper for scripts/backup-db.mjs.
# Runs a daily/weekly snapshot, retains the last N days, logs results.
#
# Usage (manual):
#   pwsh -File scripts\backup-db.ps1
#
# Usage (Task Scheduler):
#   Program:    pwsh.exe
#   Arguments:  -NoProfile -ExecutionPolicy Bypass -File "C:\Users\randi\Dev\firm-funds\scripts\backup-db.ps1"
#   Start in:   C:\Users\randi\Dev\firm-funds

# TODO (audit finding #2 CRITICAL): OFF-SITE BACKUP NOT YET CONFIGURED.
# This script writes to a local folder only. If this machine is lost,
# destroyed, or ransomware'd, every backup is gone.
# Pick ONE of these and wire it in below:
#   Option A: AWS S3 -- aws s3 cp $BackupFile s3://firmfunds-backups/ --storage-class GLACIER_IR
#   Option B: Cloudflare R2 -- rclone copy $BackupFile r2:firmfunds-backups/
#   Option C: Backblaze B2 -- b2 upload-file firmfunds-backups $BackupFile
# All three providers support Object Lock / immutability -- enable that.
# Bud's PITR/Pro plan work may include this -- coordinate before duplicating.

param(
    [int]$RetentionDays = 14,
    [string]$Label = "scheduled"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

$LogFile = Join-Path $RepoRoot "backups\backup-log.txt"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Write-Log {
    param([string]$Message)
    "$Timestamp $Message" | Tee-Object -FilePath $LogFile -Append
}

try {
    if (-not (Test-Path ".env.local")) {
        Write-Log "ERROR: .env.local not found in $RepoRoot. Backup aborted."
        exit 1
    }

    Write-Log "Starting backup (label: $Label)"
    & node scripts\backup-db.mjs --label $Label
    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: backup-db.mjs exited with code $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    # Retention: delete backups older than $RetentionDays
    $Cutoff = (Get-Date).AddDays(-$RetentionDays)
    $Removed = 0
    Get-ChildItem -Path "backups\db-*.json.gz" -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $Cutoff
    } | ForEach-Object {
        Remove-Item $_.FullName
        Remove-Item ($_.FullName -replace "\.json\.gz$", ".rowcounts.txt") -ErrorAction SilentlyContinue
        $Removed++
    }
    Write-Log "Retention sweep: removed $Removed backup(s) older than $RetentionDays days"

    Write-Log "Backup OK"
    exit 0
} catch {
    Write-Log "EXCEPTION: $_"
    exit 1
}
