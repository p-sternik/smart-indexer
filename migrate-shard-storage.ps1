#!/usr/bin/env pwsh
# Migration script to convert flat shard storage to nested hash structure

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Shard Storage Migration Utility" -ForegroundColor Cyan
Write-Host "Converting flat structure to nested hash structure" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

$smartIndexDir = ".\.smart-index"
$indexDir = Join-Path $smartIndexDir "index"

if (-not (Test-Path $indexDir)) {
    Write-Host "[ERROR] Index directory not found: $indexDir" -ForegroundColor Red
    exit 1
}

# Get all flat JSON shards
$flatShards = Get-ChildItem -Path $indexDir -Filter "*.json" -File

if ($flatShards.Count -eq 0) {
    Write-Host "[INFO] No flat shards found. Storage is already using nested structure or empty." -ForegroundColor Green
    exit 0
}

Write-Host "[INFO] Found $($flatShards.Count) shards in flat structure" -ForegroundColor Cyan
Write-Host ""

$confirm = Read-Host "Do you want to migrate these shards to nested structure? (y/N)"
if ($confirm -ne 'y' -and $confirm -ne 'Y') {
    Write-Host "[INFO] Migration cancelled" -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Starting migration..." -ForegroundColor Cyan

$migrated = 0
$errors = 0

foreach ($shard in $flatShards) {
    try {
        # Extract hash from filename (remove .json extension)
        $hash = $shard.BaseName
        
        # Calculate nested path
        $prefix1 = $hash.Substring(0, 2)
        $prefix2 = $hash.Substring(2, 2)
        
        # Create nested directory structure
        $nestedDir = Join-Path $indexDir (Join-Path $prefix1 $prefix2)
        if (-not (Test-Path $nestedDir)) {
            New-Item -Path $nestedDir -ItemType Directory -Force | Out-Null
        }
        
        # Move shard to nested location
        $newPath = Join-Path $nestedDir "$hash.json"
        Move-Item -Path $shard.FullName -Destination $newPath -Force
        
        $migrated++
        if ($migrated % 100 -eq 0) {
            Write-Host "[PROGRESS] Migrated $migrated / $($flatShards.Count) shards..." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[ERROR] Failed to migrate $($shard.Name): $_" -ForegroundColor Red
        $errors++
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Migration Complete!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Results:" -ForegroundColor White
Write-Host "  - Successfully migrated: $migrated shards" -ForegroundColor Green
Write-Host "  - Errors: $errors" -ForegroundColor $(if ($errors -eq 0) { "Green" } else { "Red" })
Write-Host ""

# Show directory structure sample
Write-Host "New directory structure sample:" -ForegroundColor Cyan
$prefixDirs = Get-ChildItem -Path $indexDir -Directory | Select-Object -First 3
foreach ($dir in $prefixDirs) {
    $subdirs = Get-ChildItem -Path $dir.FullName -Directory | Select-Object -First 2
    Write-Host "  $($dir.Name)/" -ForegroundColor Gray
    foreach ($subdir in $subdirs) {
        $shardCount = (Get-ChildItem -Path $subdir.FullName -Filter "*.json" -File).Count
        Write-Host "    $($subdir.Name)/ ($shardCount shards)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "You can now restart VS Code to use the optimized storage structure." -ForegroundColor Green
