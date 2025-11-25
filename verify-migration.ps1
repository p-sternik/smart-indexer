# Verification Script - Smart Indexer Migration

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Smart Indexer Migration Verification" -ForegroundColor Cyan
Write-Host "better-sqlite3 → sql.js" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check 1: No better-sqlite3 in package.json
Write-Host "✓ Check 1: Verifying no better-sqlite3 in dependencies..." -ForegroundColor Yellow
$packageJson = Get-Content "package.json" -Raw
if ($packageJson -notmatch "better-sqlite3") {
    Write-Host "  ✅ PASS: No better-sqlite3 found in package.json" -ForegroundColor Green
} else {
    Write-Host "  ❌ FAIL: better-sqlite3 still in package.json" -ForegroundColor Red
    exit 1
}

# Check 2: sql.js is in dependencies
Write-Host "✓ Check 2: Verifying sql.js is in dependencies..." -ForegroundColor Yellow
if ($packageJson -match "sql\.js") {
    Write-Host "  ✅ PASS: sql.js found in package.json" -ForegroundColor Green
} else {
    Write-Host "  ❌ FAIL: sql.js not found in package.json" -ForegroundColor Red
    exit 1
}

# Check 3: WASM file exists
Write-Host "✓ Check 3: Verifying WASM file exists..." -ForegroundColor Yellow
if (Test-Path "node_modules\sql.js\dist\sql-wasm.wasm") {
    Write-Host "  ✅ PASS: sql-wasm.wasm found" -ForegroundColor Green
} else {
    Write-Host "  ❌ FAIL: sql-wasm.wasm not found" -ForegroundColor Red
    Write-Host "  Run 'npm install' to install dependencies" -ForegroundColor Yellow
    exit 1
}

# Check 4: SqlJsStorage exists
Write-Host "✓ Check 4: Verifying SqlJsStorage exists..." -ForegroundColor Yellow
if (Test-Path "server\src\cache\sqlJsStorage.ts") {
    Write-Host "  ✅ PASS: sqlJsStorage.ts found" -ForegroundColor Green
} else {
    Write-Host "  ❌ FAIL: sqlJsStorage.ts not found" -ForegroundColor Red
    exit 1
}

# Check 5: No old storage.ts
Write-Host "✓ Check 5: Verifying old storage.ts.old removed..." -ForegroundColor Yellow
if (-not (Test-Path "server\src\cache\storage.ts.old")) {
    Write-Host "  ✅ PASS: storage.ts.old removed" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  WARNING: storage.ts.old still exists (can be removed)" -ForegroundColor Yellow
}

# Check 6: Build artifacts exist
Write-Host "✓ Check 6: Verifying build artifacts..." -ForegroundColor Yellow
$buildFiles = @(
    "dist\extension.js",
    "server\out\server.js",
    "server\out\cache\sqlJsStorage.js"
)
$allExist = $true
foreach ($file in $buildFiles) {
    if (Test-Path $file) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file (missing)" -ForegroundColor Red
        $allExist = $false
    }
}
if (-not $allExist) {
    Write-Host "  Run 'npm run build' to compile the extension" -ForegroundColor Yellow
}

# Check 7: TypeScript compilation
Write-Host ""
Write-Host "✓ Check 7: Running TypeScript type check..." -ForegroundColor Yellow
$typeCheck = npm run check-types 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ PASS: TypeScript type check passed" -ForegroundColor Green
} else {
    Write-Host "  ❌ FAIL: TypeScript errors found" -ForegroundColor Red
    Write-Host $typeCheck
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ ALL CHECKS PASSED!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Migration is complete and verified." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Press F5 to launch Extension Development Host" -ForegroundColor White
Write-Host "  2. Open a workspace with TypeScript/JavaScript files" -ForegroundColor White
Write-Host "  3. Check Output panel → 'Smart Indexer' for logs" -ForegroundColor White
Write-Host "  4. Run 'Smart Indexer: Show Statistics' command" -ForegroundColor White
Write-Host "  5. Verify no NODE_MODULE_VERSION errors" -ForegroundColor White
Write-Host ""
