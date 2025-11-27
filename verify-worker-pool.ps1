#!/usr/bin/env pwsh
# Verification script for Worker Pool implementation

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Smart Indexer - Worker Pool Verification" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

$errors = 0
$warnings = 0

# 1. Check if worker.js is compiled
Write-Host "[1/7] Checking compiled worker..." -ForegroundColor Yellow
$workerPath = "server\out\indexer\worker.js"
if (Test-Path $workerPath) {
    $workerSize = (Get-Item $workerPath).Length
    Write-Host "  ✓ Worker compiled: $workerPath ($([math]::Round($workerSize/1MB, 2)) MB)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Worker not found: $workerPath" -ForegroundColor Red
    Write-Host "    Run: npm run compile:server" -ForegroundColor Yellow
    $errors++
}

# 2. Check if server is compiled
Write-Host "[2/7] Checking compiled server..." -ForegroundColor Yellow
$serverPath = "server\out\server.js"
if (Test-Path $serverPath) {
    Write-Host "  ✓ Server compiled: $serverPath" -ForegroundColor Green
} else {
    Write-Host "  ✗ Server not found: $serverPath" -ForegroundColor Red
    Write-Host "    Run: npm run compile:server" -ForegroundColor Yellow
    $errors++
}

# 3. Check if extension is compiled
Write-Host "[3/7] Checking compiled extension..." -ForegroundColor Yellow
$extensionPath = "dist\extension.js"
if (Test-Path $extensionPath) {
    Write-Host "  ✓ Extension compiled: $extensionPath" -ForegroundColor Green
} else {
    Write-Host "  ✗ Extension not found: $extensionPath" -ForegroundColor Red
    Write-Host "    Run: npm run compile:client" -ForegroundColor Yellow
    $errors++
}

# 4. Check TypeScript compilation
Write-Host "[4/7] Running TypeScript type check..." -ForegroundColor Yellow
$tscResult = npm run check-types 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ TypeScript types valid" -ForegroundColor Green
} else {
    Write-Host "  ✗ TypeScript errors found" -ForegroundColor Red
    Write-Host $tscResult -ForegroundColor Gray
    $errors++
}

# 5. Check linting
Write-Host "[5/7] Running ESLint..." -ForegroundColor Yellow
$lintResult = npm run lint 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ No linting errors" -ForegroundColor Green
} else {
    Write-Host "  ✗ Linting errors found" -ForegroundColor Red
    Write-Host $lintResult -ForegroundColor Gray
    $errors++
}

# 6. Check documentation files
Write-Host "[6/7] Checking documentation..." -ForegroundColor Yellow
$docFiles = @(
    "docs\WORKER_POOL_OPTIMIZATION.md",
    "docs\WORKER_POOL_QUICK_REF.md",
    "docs\WORKER_POOL_IMPLEMENTATION.md",
    "docs\WORKER_POOL_GUIDE.md",
    "docs\WORKER_POOL_SUMMARY.md"
)

$missingDocs = 0
foreach ($doc in $docFiles) {
    if (Test-Path $doc) {
        Write-Host "  ✓ $doc" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Missing: $doc" -ForegroundColor Red
        $missingDocs++
    }
}

if ($missingDocs -eq 0) {
    Write-Host "  ✓ All documentation files present" -ForegroundColor Green
} else {
    Write-Host "  ⚠ $missingDocs documentation file(s) missing" -ForegroundColor Yellow
    $warnings++
}

# 7. Check source file modifications
Write-Host "[7/7] Verifying source files..." -ForegroundColor Yellow
$sourceFiles = @(
    "server\src\index\backgroundIndex.ts",
    "server\src\indexer\worker.ts",
    "server\src\utils\workerPool.ts"
)

foreach ($file in $sourceFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Missing: $file" -ForegroundColor Red
        $errors++
    }
}

# Summary
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Verification Summary" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

if ($errors -eq 0 -and $warnings -eq 0) {
    Write-Host "✓ All checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Worker pool implementation is ready for use." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Open workspace in VS Code" -ForegroundColor White
    Write-Host "  2. Open Developer Console (Help > Toggle Developer Tools)" -ForegroundColor White
    Write-Host "  3. Look for worker pool initialization logs" -ForegroundColor White
    Write-Host "  4. Run: Smart Indexer: Rebuild Index" -ForegroundColor White
    Write-Host "  5. Verify indexing completes successfully" -ForegroundColor White
    exit 0
} elseif ($errors -eq 0) {
    Write-Host "⚠ Passed with warnings: $warnings" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Implementation is functional but some documentation may be missing." -ForegroundColor Yellow
    exit 0
} else {
    Write-Host "✗ Failed with errors: $errors" -ForegroundColor Red
    if ($warnings -gt 0) {
        Write-Host "⚠ Warnings: $warnings" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Please fix the errors above before proceeding." -ForegroundColor Red
    exit 1
}
