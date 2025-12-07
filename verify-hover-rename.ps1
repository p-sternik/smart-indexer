# Verify Hover and Rename Implementation
# This script checks that the handlers are properly integrated

Write-Host "=== Verifying Hover and Rename Implementation ===" -ForegroundColor Cyan
Write-Host ""

$errors = 0

# 1. Check handler files exist
Write-Host "[1/6] Checking handler files..." -ForegroundColor Yellow
$handlerFiles = @(
    "server\src\handlers\hoverHandler.ts",
    "server\src\handlers\renameHandler.ts"
)

foreach ($file in $handlerFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file exists" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file missing" -ForegroundColor Red
        $errors++
    }
}

# 2. Check compiled JavaScript files exist
Write-Host ""
Write-Host "[2/6] Checking compiled output..." -ForegroundColor Yellow
$compiledFiles = @(
    "server\out\handlers\hoverHandler.js",
    "server\out\handlers\renameHandler.js"
)

foreach ($file in $compiledFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file compiled" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file not compiled (run npm run compile)" -ForegroundColor Red
        $errors++
    }
}

# 3. Check handlers are exported from index
Write-Host ""
Write-Host "[3/6] Checking handler exports..." -ForegroundColor Yellow
$indexContent = Get-Content "server\src\handlers\index.ts" -Raw
if ($indexContent -match "createHoverHandler" -and $indexContent -match "createRenameHandler") {
    Write-Host "  ✓ Handlers exported from index.ts" -ForegroundColor Green
} else {
    Write-Host "  ✗ Handlers not exported from index.ts" -ForegroundColor Red
    $errors++
}

# 4. Check server.ts imports handlers
Write-Host ""
Write-Host "[4/6] Checking server.ts imports..." -ForegroundColor Yellow
$serverContent = Get-Content "server\src\server.ts" -Raw
if ($serverContent -match "createHoverHandler" -and $serverContent -match "createRenameHandler") {
    Write-Host "  ✓ Handlers imported in server.ts" -ForegroundColor Green
} else {
    Write-Host "  ✗ Handlers not imported in server.ts" -ForegroundColor Red
    $errors++
}

# 5. Check handlers are registered
Write-Host ""
Write-Host "[5/6] Checking handler registration..." -ForegroundColor Yellow
if ($serverContent -match "handlerRegistry\.register\(createHoverHandler\)" -and 
    $serverContent -match "handlerRegistry\.register\(createRenameHandler\)") {
    Write-Host "  ✓ Handlers registered with HandlerRegistry" -ForegroundColor Green
} else {
    Write-Host "  ✗ Handlers not registered in server.ts" -ForegroundColor Red
    $errors++
}

# 6. Check capabilities declared in InitializationHandler
Write-Host ""
Write-Host "[6/6] Checking LSP capabilities..." -ForegroundColor Yellow
$initHandlerContent = Get-Content "server\src\handlers\InitializationHandler.ts" -Raw
if ($initHandlerContent -match "hoverProvider:\s*true" -and 
    $initHandlerContent -match "renameProvider:\s*\{") {
    Write-Host "  ✓ Capabilities declared in InitializationHandler" -ForegroundColor Green
} else {
    Write-Host "  ✗ Capabilities not declared in InitializationHandler" -ForegroundColor Red
    $errors++
}

# Summary
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
if ($errors -eq 0) {
    Write-Host "✓ ALL CHECKS PASSED" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Press F5 in VS Code to launch Extension Development Host"
    Write-Host "  2. Open a TypeScript file"
    Write-Host "  3. Hover over a symbol to test HoverProvider"
    Write-Host "  4. Press F2 on a symbol to test RenameProvider"
    Write-Host ""
    Write-Host "See HOVER_RENAME_IMPLEMENTATION.md for testing checklist" -ForegroundColor Gray
} else {
    Write-Host "✗ $errors CHECK(S) FAILED" -ForegroundColor Red
    Write-Host ""
    Write-Host "Fix the errors above and run 'npm run compile' again" -ForegroundColor Yellow
}
Write-Host "================================================" -ForegroundColor Cyan
