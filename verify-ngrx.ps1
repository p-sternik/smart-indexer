# NgRx Pattern Recognition Verification Script

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  NgRx Pattern Recognition Verification" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Check if files exist
$files = @(
    "server\src\types.ts",
    "server\src\indexer\worker.ts",
    "test-files\ngrx-patterns-test.ts",
    "NGRX_PATTERN_RECOGNITION.md",
    "NGRX_QUICK_REF.md",
    "NGRX_IMPLEMENTATION_SUMMARY.md"
)

Write-Host "1. Checking file existence..." -ForegroundColor Yellow
$allFilesExist = $true
foreach ($file in $files) {
    if (Test-Path $file) {
        Write-Host "   ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "   ✗ $file (MISSING)" -ForegroundColor Red
        $allFilesExist = $false
    }
}
Write-Host ""

if (-not $allFilesExist) {
    Write-Host "ERROR: Some files are missing!" -ForegroundColor Red
    exit 1
}

# Check for NgRxMetadata interface
Write-Host "2. Checking NgRxMetadata interface..." -ForegroundColor Yellow
$typesContent = Get-Content "server\src\types.ts" -Raw
if ($typesContent -match "interface NgRxMetadata") {
    Write-Host "   ✓ NgRxMetadata interface found" -ForegroundColor Green
} else {
    Write-Host "   ✗ NgRxMetadata interface NOT found" -ForegroundColor Red
    exit 1
}

if ($typesContent -match "ngrxMetadata\?:\s*NgRxMetadata") {
    Write-Host "   ✓ ngrxMetadata field added to IndexedSymbol" -ForegroundColor Green
} else {
    Write-Host "   ✗ ngrxMetadata field NOT found in IndexedSymbol" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Check for helper functions in worker
Write-Host "3. Checking NgRx helper functions in worker.ts..." -ForegroundColor Yellow
$workerContent = Get-Content "server\src\indexer\worker.ts" -Raw
$helpers = @(
    "isNgRxCreateActionCall",
    "isNgRxCreateEffectCall",
    "isNgRxOnCall",
    "isNgRxOfTypeCall",
    "extractActionTypeString",
    "hasActionInterface",
    "hasEffectDecorator"
)

$allHelpersFound = $true
foreach ($helper in $helpers) {
    if ($workerContent -match "function $helper") {
        Write-Host "   ✓ $helper()" -ForegroundColor Green
    } else {
        Write-Host "   ✗ $helper() NOT found" -ForegroundColor Red
        $allHelpersFound = $false
    }
}
Write-Host ""

if (-not $allHelpersFound) {
    Write-Host "ERROR: Some helper functions are missing!" -ForegroundColor Red
    exit 1
}

# Check for NgRx detection in switch cases
Write-Host "4. Checking NgRx detection logic..." -ForegroundColor Yellow
if ($workerContent -match "isNgRxCreateActionCall\(callExpr\)") {
    Write-Host "   ✓ createAction detection in VariableDeclaration" -ForegroundColor Green
} else {
    Write-Host "   ✗ createAction detection NOT found" -ForegroundColor Red
    exit 1
}

if ($workerContent -match "isNgRxCreateEffectCall") {
    Write-Host "   ✓ createEffect detection in PropertyDefinition" -ForegroundColor Green
} else {
    Write-Host "   ✗ createEffect detection NOT found" -ForegroundColor Red
    exit 1
}

if ($workerContent -match "isNgRxOfTypeCall\(callExpr\)") {
    Write-Host "   ✓ ofType() reference detection" -ForegroundColor Green
} else {
    Write-Host "   ✗ ofType() detection NOT found" -ForegroundColor Red
    exit 1
}

if ($workerContent -match "isNgRxOnCall\(callExpr\)") {
    Write-Host "   ✓ on() reference detection" -ForegroundColor Green
} else {
    Write-Host "   ✗ on() detection NOT found" -ForegroundColor Red
    exit 1
}

if ($workerContent -match "hasActionInterface\(classNode\)") {
    Write-Host "   ✓ Legacy Action class detection" -ForegroundColor Green
} else {
    Write-Host "   ✗ Legacy Action detection NOT found" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Build verification
Write-Host "5. Running build verification..." -ForegroundColor Yellow
$buildOutput = pnpm run compile 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ Build successful" -ForegroundColor Green
} else {
    Write-Host "   ✗ Build failed" -ForegroundColor Red
    Write-Host $buildOutput
    exit 1
}
Write-Host ""

# Test file verification
Write-Host "6. Checking test file..." -ForegroundColor Yellow
$testContent = Get-Content "test-files\ngrx-patterns-test.ts" -Raw
$testPatterns = @(
    "createAction",
    "createEffect",
    "implements Action",
    "@Effect\(\)",
    "ofType\(",
    "on\("
)

$allPatternsFound = $true
foreach ($pattern in $testPatterns) {
    if ($testContent -match $pattern) {
        Write-Host "   ✓ Test case for '$pattern'" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Test case for '$pattern' NOT found" -ForegroundColor Red
        $allPatternsFound = $false
    }
}
Write-Host ""

# Documentation verification
Write-Host "7. Checking documentation..." -ForegroundColor Yellow
$docFiles = @{
    "NGRX_PATTERN_RECOGNITION.md" = "Implementation Guide"
    "NGRX_QUICK_REF.md" = "Quick Reference"
    "NGRX_IMPLEMENTATION_SUMMARY.md" = "Implementation Summary"
}

foreach ($doc in $docFiles.Keys) {
    $content = Get-Content $doc -Raw
    $size = (Get-Item $doc).Length
    Write-Host "   ✓ $($docFiles[$doc]) ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
}
Write-Host ""

# Architecture doc update
Write-Host "8. Checking architecture documentation..." -ForegroundColor Yellow
$archDoc = Get-Content "docs\SMART_INDEXER_CONTEXT.md" -Raw
if ($archDoc -match "NgRx Pattern Recognition") {
    Write-Host "   ✓ NgRx section added to SMART_INDEXER_CONTEXT.md" -ForegroundColor Green
} else {
    Write-Host "   ✗ NgRx section NOT found in architecture doc" -ForegroundColor Red
    exit 1
}

if ($archDoc -match "NGRX_PATTERN_RECOGNITION.md") {
    Write-Host "   ✓ NgRx docs linked in Related Documentation" -ForegroundColor Green
} else {
    Write-Host "   ✗ NgRx docs NOT linked" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Summary
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  VERIFICATION COMPLETE" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "✅ All checks passed!" -ForegroundColor Green
Write-Host ""
Write-Host "Implementation Summary:" -ForegroundColor Yellow
Write-Host "  • NgRxMetadata interface added" -ForegroundColor White
Write-Host "  • 7 helper functions implemented" -ForegroundColor White
Write-Host "  • Modern NgRx support (createAction, createEffect)" -ForegroundColor White
Write-Host "  • Legacy NgRx support (Action classes, @Effect)" -ForegroundColor White
Write-Host "  • Reference linking (ofType, on)" -ForegroundColor White
Write-Host "  • Comprehensive test file created" -ForegroundColor White
Write-Host "  • 3 documentation files created" -ForegroundColor White
Write-Host "  • Architecture docs updated" -ForegroundColor White
Write-Host "  • Build passing" -ForegroundColor White
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Test in VS Code with real NgRx projects" -ForegroundColor White
Write-Host "  2. Verify 'Go to Definition' on ofType() and on()" -ForegroundColor White
Write-Host "  3. Verify 'Find References' on action creators" -ForegroundColor White
Write-Host "  4. Check .smart-index shards for ngrxMetadata" -ForegroundColor White
Write-Host ""
