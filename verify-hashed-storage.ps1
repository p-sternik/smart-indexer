#!/usr/bin/env pwsh
# Verification script for hashed directory storage optimization

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Hashed Directory Storage Verification" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Check if .smart-index directory exists
$smartIndexDir = ".\.smart-index"
if (Test-Path $smartIndexDir) {
    Write-Host "[OK] .smart-index directory exists" -ForegroundColor Green
    
    # Check for nested structure
    $indexDir = Join-Path $smartIndexDir "index"
    if (Test-Path $indexDir) {
        Write-Host "[OK] index directory exists" -ForegroundColor Green
        
        # Look for nested directories (hash prefixes)
        $subdirs = Get-ChildItem -Path $indexDir -Directory -ErrorAction SilentlyContinue
        if ($subdirs.Count -gt 0) {
            Write-Host "[OK] Found $($subdirs.Count) prefix directories (nested structure)" -ForegroundColor Green
            
            # Check if they follow the pattern (2 character names)
            $validPrefix = $subdirs | Where-Object { $_.Name -match '^[a-f0-9]{2}$' }
            if ($validPrefix.Count -gt 0) {
                Write-Host "[OK] Valid hash prefix directories: $($validPrefix.Count)" -ForegroundColor Green
                
                # Check second level nesting
                $firstPrefix = $validPrefix[0]
                $secondLevel = Get-ChildItem -Path $firstPrefix.FullName -Directory -ErrorAction SilentlyContinue
                if ($secondLevel.Count -gt 0) {
                    Write-Host "[OK] Second-level nesting detected (2-tier structure)" -ForegroundColor Green
                    
                    # Show example structure
                    $exampleShard = Get-ChildItem -Path $secondLevel[0].FullName -Filter "*.json" -File | Select-Object -First 1
                    if ($exampleShard) {
                        $relativePath = $exampleShard.FullName.Replace((Get-Location).Path, ".")
                        Write-Host "[INFO] Example shard: $relativePath" -ForegroundColor Cyan
                    }
                } else {
                    Write-Host "[INFO] No second-level directories yet (might be using old flat structure)" -ForegroundColor Yellow
                }
            } else {
                Write-Host "[INFO] Directories don't follow hash prefix pattern (might be old structure)" -ForegroundColor Yellow
            }
        } else {
            # Check for flat structure (old format)
            $flatShards = Get-ChildItem -Path $indexDir -Filter "*.json" -File -ErrorAction SilentlyContinue
            if ($flatShards.Count -gt 0) {
                Write-Host "[WARN] Found $($flatShards.Count) shards in flat structure (old format)" -ForegroundColor Yellow
                Write-Host "[INFO] Shards will be migrated to nested structure on next index" -ForegroundColor Cyan
            } else {
                Write-Host "[INFO] No shards found yet (index not initialized)" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "[INFO] index directory doesn't exist yet" -ForegroundColor Yellow
    }
} else {
    Write-Host "[INFO] .smart-index directory doesn't exist yet" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Checking .gitignore configuration..." -ForegroundColor Cyan

if (Test-Path ".gitignore") {
    $gitignoreContent = Get-Content ".gitignore" -Raw
    if ($gitignoreContent -match '\.smart-index') {
        Write-Host "[OK] .smart-index is in .gitignore" -ForegroundColor Green
    } else {
        Write-Host "[WARN] .smart-index NOT found in .gitignore (will be added on extension activation)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[INFO] .gitignore doesn't exist (will be created on extension activation)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Code Changes Summary" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Hashed Directory Structure:" -ForegroundColor White
Write-Host "   - Modified: server/src/index/backgroundIndex.ts" -ForegroundColor Gray
Write-Host "   - Path format: .smart-index/index/<hash[0:2]>/<hash[2:4]>/<hash>.json" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Git Ignore Automation:" -ForegroundColor White
Write-Host "   - Modified: src/extension.ts" -ForegroundColor Gray
Write-Host "   - Auto-adds cache directory to .gitignore on activation" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Documentation Updates:" -ForegroundColor White
Write-Host "   - Updated: CHANGELOG.md" -ForegroundColor Gray
Write-Host "   - Updated: docs/ARCHITECTURE.md" -ForegroundColor Gray
Write-Host ""
Write-Host "Verification complete!" -ForegroundColor Green
