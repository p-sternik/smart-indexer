#!/usr/bin/env pwsh
# Verification script for Hybrid Deduplication implementation

Write-Host "=== Hybrid Deduplication Verification ===" -ForegroundColor Cyan
Write-Host ""

# Check if provider files exist
Write-Host "1. Checking provider files..." -ForegroundColor Yellow
$definitionProvider = "src\providers\HybridDefinitionProvider.ts"
$referencesProvider = "src\providers\HybridReferencesProvider.ts"

if (Test-Path $definitionProvider) {
    Write-Host "   ✓ HybridDefinitionProvider.ts exists" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridDefinitionProvider.ts NOT found" -ForegroundColor Red
    exit 1
}

if (Test-Path $referencesProvider) {
    Write-Host "   ✓ HybridReferencesProvider.ts exists" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridReferencesProvider.ts NOT found" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Check extension.ts imports
Write-Host "2. Checking extension.ts imports..." -ForegroundColor Yellow
$extensionContent = Get-Content "src\extension.ts" -Raw

if ($extensionContent -match "import.*HybridDefinitionProvider") {
    Write-Host "   ✓ HybridDefinitionProvider imported" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridDefinitionProvider NOT imported" -ForegroundColor Red
    exit 1
}

if ($extensionContent -match "import.*HybridReferencesProvider") {
    Write-Host "   ✓ HybridReferencesProvider imported" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridReferencesProvider NOT imported" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Check provider registration
Write-Host "3. Checking provider registration..." -ForegroundColor Yellow

if ($extensionContent -match "new HybridDefinitionProvider") {
    Write-Host "   ✓ HybridDefinitionProvider instantiated" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridDefinitionProvider NOT instantiated" -ForegroundColor Red
    exit 1
}

if ($extensionContent -match "new HybridReferencesProvider") {
    Write-Host "   ✓ HybridReferencesProvider instantiated" -ForegroundColor Green
} else {
    Write-Host "   ✗ HybridReferencesProvider NOT instantiated" -ForegroundColor Red
    exit 1
}

if ($extensionContent -match "registerDefinitionProvider") {
    Write-Host "   ✓ Definition provider registered" -ForegroundColor Green
} else {
    Write-Host "   ✗ Definition provider NOT registered" -ForegroundColor Red
    exit 1
}

if ($extensionContent -match "registerReferenceProvider") {
    Write-Host "   ✓ Reference provider registered" -ForegroundColor Green
} else {
    Write-Host "   ✗ Reference provider NOT registered" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Check hybrid mode condition
Write-Host "4. Checking hybrid mode condition..." -ForegroundColor Yellow

if ($extensionContent -match "if \(mode === 'hybrid'\)") {
    Write-Host "   ✓ Hybrid mode condition present" -ForegroundColor Green
} else {
    Write-Host "   ✗ Hybrid mode condition NOT found" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Check deduplication logic
Write-Host "5. Checking deduplication logic..." -ForegroundColor Yellow

$definitionContent = Get-Content $definitionProvider -Raw

if ($definitionContent -match "mergeAndDeduplicate") {
    Write-Host "   ✓ mergeAndDeduplicate method exists" -ForegroundColor Green
} else {
    Write-Host "   ✗ mergeAndDeduplicate method NOT found" -ForegroundColor Red
    exit 1
}

if ($definitionContent -match "areLocationsSimilar") {
    Write-Host "   ✓ Proximity heuristic implemented" -ForegroundColor Green
} else {
    Write-Host "   ✗ Proximity heuristic NOT found" -ForegroundColor Red
    exit 1
}

if ($definitionContent -match "Promise\.all") {
    Write-Host "   ✓ Parallel fetching implemented" -ForegroundColor Green
} else {
    Write-Host "   ✗ Parallel fetching NOT found" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Check build
Write-Host "6. Running TypeScript compilation..." -ForegroundColor Yellow
$buildOutput = pnpm run compile 2>&1 | Out-String

if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ Build successful" -ForegroundColor Green
} else {
    Write-Host "   ✗ Build failed" -ForegroundColor Red
    Write-Host $buildOutput
    exit 1
}

Write-Host ""

# Check documentation
Write-Host "7. Checking documentation..." -ForegroundColor Yellow

if (Test-Path "HYBRID_DEDUPLICATION.md") {
    Write-Host "   ✓ Full documentation exists" -ForegroundColor Green
} else {
    Write-Host "   ⚠ Full documentation missing" -ForegroundColor Yellow
}

if (Test-Path "HYBRID_DEDUPLICATION_QUICK_REF.md") {
    Write-Host "   ✓ Quick reference exists" -ForegroundColor Green
} else {
    Write-Host "   ⚠ Quick reference missing" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Verification Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  • Hybrid providers implemented and registered" -ForegroundColor Green
Write-Host "  • Deduplication logic with proximity heuristic" -ForegroundColor Green
Write-Host "  • Parallel fetching for optimal performance" -ForegroundColor Green
Write-Host "  • Build successful" -ForegroundColor Green
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Set 'smartIndexer.mode' to 'hybrid' in VS Code settings"
Write-Host "  2. Reload VS Code window (Ctrl+R or Cmd+R)"
Write-Host "  3. Test 'Go to Definition' on any symbol"
Write-Host "  4. Check 'Smart Indexer' output channel for deduplication logs"
Write-Host ""
